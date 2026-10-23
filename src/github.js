// Minimal GitHub REST client (fetch only) for the Action.
export class GitHub {
    constructor({ token, apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com', repository = process.env.GITHUB_REPOSITORY, fetchImpl = fetch }) {
        if (!token) throw new Error('github-token is required to comment on the pull request');
        Object.defineProperty(this, 'token', { value: token, enumerable: false });
        this.api = apiUrl.replace(/\/$/, '');
        // GHES serves GraphQL at /api/graphql, not /api/v3/graphql; Actions exposes the right URL.
        this.graphqlUrl = process.env.GITHUB_GRAPHQL_URL && this.api === String(process.env.GITHUB_API_URL || '').replace(/\/$/, '') ? process.env.GITHUB_GRAPHQL_URL : `${this.api}/graphql`;
        [this.owner, this.repo] = String(repository).split('/');
        this.fetch = fetchImpl;
    }

    async req(method, path, body, url = `${this.api}${path}`) {
        const res = await this.fetch(url, {
            method,
            headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'framedrift', ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
        return text ? JSON.parse(text) : null;
    }

    /** PRs that contain this commit (works for deployment_status events). */
    async pullsForCommit(sha) {
        const prs = await this.req('GET', `/repos/${this.owner}/${this.repo}/commits/${sha}/pulls`);
        return (prs || []).filter((p) => p.state === 'open');
    }

    getPull(number) { return this.req('GET', `/repos/${this.owner}/${this.repo}/pulls/${number}`); }

    /**
     * Exact login of the identity this token acts as (R68-04 / N5):
     * - a PAT: GET /user;
     * - GITHUB_TOKEN / GitHub App installation tokens (GET /user is 403 for them): GraphQL `viewer { login }`, which
     *   returns the app's bot login, e.g. "github-actions[bot]" or "my-app[bot]";
     * - if neither answers: "github-actions[bot]", the author of comments made with the default GITHUB_TOKEN.
     */
    async viewerLogin() {
        if (this.login !== undefined) return this.login;
        let login = null;
        try { const u = await this.req('GET', '/user'); if (typeof u?.login === 'string') login = u.login; } catch { /* app token */ }
        if (!login) {
            try {
                const g = await this.req('POST', '/graphql', { query: 'query { viewer { login } }' }, this.graphqlUrl);
                if (typeof g?.data?.viewer?.login === 'string') login = g.data.viewer.login;
            } catch { /* no GraphQL access */ }
        }
        this.login = login || 'github-actions[bot]';
        return this.login;
    }

    /**
     * Create or update the single framedrift comment on a PR: the one with the marker written by exactly the
     * identity this token acts as (see viewerLogin). A human's or another app's comment quoting the marker is ignored.
     */
    async upsertComment(number, body, marker) {
        let existing = null;
        for (let page = 1; page <= 5 && !existing; page++) {
            const comments = await this.req('GET', `/repos/${this.owner}/${this.repo}/issues/${number}/comments?per_page=100&page=${page}`);
            const marked = comments.filter((c) => c.body && c.body.includes(marker));
            if (marked.length) {
                const me = await this.viewerLogin();
                existing = marked.find((c) => c.user?.login === me);
            }
            if (comments.length < 100) break;
        }
        if (existing) return { action: 'updated', comment: await this.req('PATCH', `/repos/${this.owner}/${this.repo}/issues/comments/${existing.id}`, { body }) };
        return { action: 'created', comment: await this.req('POST', `/repos/${this.owner}/${this.repo}/issues/${number}/comments`, { body }) };
    }
}

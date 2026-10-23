// Minimal GitHub REST client (fetch only) for the Action.
export class GitHub {
    constructor({ token, apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com', repository = process.env.GITHUB_REPOSITORY, fetchImpl = fetch }) {
        if (!token) throw new Error('github-token is required to comment on the pull request');
        Object.defineProperty(this, 'token', { value: token, enumerable: false });
        this.api = apiUrl.replace(/\/$/, '');
        [this.owner, this.repo] = String(repository).split('/');
        this.fetch = fetchImpl;
    }

    async req(method, path, body) {
        const res = await this.fetch(`${this.api}${path}`, {
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

    /** Login of the token's user (a PAT); null for GITHUB_TOKEN / app tokens, which can't call GET /user. */
    async viewerLogin() {
        try { const u = await this.req('GET', '/user'); return typeof u?.login === 'string' ? u.login : null; } catch { return null; }
    }

    /**
     * Create or update the single framedrift comment on a PR: the one with the marker that WE wrote (a bot
     * account such as github-actions[bot], or the PAT's own user). A human comment quoting the marker is ignored.
     */
    async upsertComment(number, body, marker) {
        let existing = null;
        let me;
        for (let page = 1; page <= 5 && !existing; page++) {
            const comments = await this.req('GET', `/repos/${this.owner}/${this.repo}/issues/${number}/comments?per_page=100&page=${page}`);
            const marked = comments.filter((c) => c.body && c.body.includes(marker));
            if (marked.length && me === undefined && !marked.some((c) => c.user?.type === 'Bot')) me = await this.viewerLogin();
            existing = marked.find((c) => c.user?.type === 'Bot' || (me && c.user?.login === me));
            if (comments.length < 100) break;
        }
        if (existing) return { action: 'updated', comment: await this.req('PATCH', `/repos/${this.owner}/${this.repo}/issues/comments/${existing.id}`, { body }) };
        return { action: 'created', comment: await this.req('POST', `/repos/${this.owner}/${this.repo}/issues/${number}/comments`, { body }) };
    }
}

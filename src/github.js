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

    /** Create or update the single framedrift comment on a PR (found by marker). */
    async upsertComment(number, body, marker) {
        let existing = null;
        for (let page = 1; page <= 5 && !existing; page++) {
            const comments = await this.req('GET', `/repos/${this.owner}/${this.repo}/issues/${number}/comments?per_page=100&page=${page}`);
            existing = comments.find((c) => c.body && c.body.includes(marker));
            if (comments.length < 100) break;
        }
        if (existing) return { action: 'updated', comment: await this.req('PATCH', `/repos/${this.owner}/${this.repo}/issues/comments/${existing.id}`, { body }) };
        return { action: 'created', comment: await this.req('POST', `/repos/${this.owner}/${this.repo}/issues/${number}/comments`, { body }) };
    }
}

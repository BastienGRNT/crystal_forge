/**
 * Client API GitHub REST (Octokit) avec un jeton fine-grained.
 * Aucune règle de sécurité ici : toujours utilisé derrière GithubGateway.
 */
import { Octokit } from '@octokit/rest';
import { ExternalApiError } from '$lib/domain/errors';
import type { GhDirEntry, GhRepo, GhRun, GhRunJob, GhRunner, GithubApi } from '$server/application/ports';

function wrap(err: unknown, what: string): never {
	const e = err as { status?: number; message?: string; response?: { data?: { message?: string } } };
	const status = e.status;
	let msg = e.response?.data?.message ?? e.message ?? String(err);
	if (status === 401) msg = 'jeton invalide ou expiré';
	if (status === 403 && /not accessible/i.test(msg)) msg = `${msg} — vérifiez les permissions du jeton fine-grained`;
	throw new ExternalApiError('GitHub', `${what} : ${msg}`, status);
}

function toRepo(r: {
	owner: { login: string };
	name: string;
	full_name: string;
	private: boolean;
	default_branch?: string;
	description: string | null;
	pushed_at?: string | null;
	html_url: string;
	archived?: boolean;
}): GhRepo {
	return {
		owner: r.owner.login,
		name: r.name,
		fullName: r.full_name,
		private: r.private,
		defaultBranch: r.default_branch ?? 'main',
		description: r.description,
		pushedAt: r.pushed_at ?? null,
		htmlUrl: r.html_url,
		archived: r.archived ?? false
	};
}

type RawRun = {
	id: number;
	run_number: number;
	name?: string | null;
	status: string | null;
	conclusion: string | null;
	event: string;
	head_sha: string;
	head_branch: string | null;
	head_commit?: { message?: string } | null;
	actor?: { login: string } | null;
	created_at: string;
	updated_at: string;
	html_url: string;
};

function toRun(r: RawRun): GhRun {
	return {
		id: r.id,
		runNumber: r.run_number,
		name: r.name ?? '',
		status: r.status ?? 'unknown',
		conclusion: r.conclusion,
		event: r.event,
		headSha: r.head_sha,
		headBranch: r.head_branch,
		commitMessage: r.head_commit?.message?.split('\n')[0] ?? null,
		actor: r.actor?.login ?? null,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		htmlUrl: r.html_url
	};
}

export class GithubClient implements GithubApi {
	readonly #o: Octokit;

	constructor(token: string) {
		if (!token) throw new ExternalApiError('GitHub', 'jeton non configuré (Réglages → GitHub)');
		this.#o = new Octokit({ auth: token, userAgent: 'forge-mini-paas', request: { timeout: 30_000 } });
	}

	async whoami() {
		try {
			const res = await this.#o.rest.users.getAuthenticated();
			return { login: res.data.login, tokenExpiresAt: (res.headers['github-authentication-token-expiration'] as string | undefined) ?? null };
		} catch (e) {
			wrap(e, 'identification');
		}
	}

	async listRepos() {
		try {
			const rows = await this.#o.paginate(this.#o.rest.repos.listForAuthenticatedUser, { per_page: 100, sort: 'pushed', affiliation: 'owner' });
			return rows.map(toRepo);
		} catch (e) {
			wrap(e, 'liste des dépôts');
		}
	}

	async getRepo(owner: string, repo: string) {
		try {
			return toRepo((await this.#o.rest.repos.get({ owner, repo })).data);
		} catch (e) {
			wrap(e, `dépôt ${owner}/${repo}`);
		}
	}

	async listDir(owner: string, repo: string, path: string, ref?: string): Promise<GhDirEntry[]> {
		try {
			const res = await this.#o.rest.repos.getContent({ owner, repo, path, ref });
			if (!Array.isArray(res.data)) return [];
			return res.data.map((e) => ({ name: e.name, path: e.path, type: e.type as GhDirEntry['type'] }));
		} catch (e) {
			if ((e as { status?: number }).status === 404) return [];
			wrap(e, `contenu de ${path || '/'}`);
		}
	}

	async getFile(owner: string, repo: string, path: string, ref?: string) {
		try {
			const res = await this.#o.rest.repos.getContent({ owner, repo, path, ref });
			const d = res.data as { type?: string; content?: string; sha: string; encoding?: string };
			if (Array.isArray(res.data) || d.type !== 'file') return null;
			const content = d.encoding === 'base64' ? Buffer.from(d.content ?? '', 'base64').toString('utf8') : (d.content ?? '');
			return { content, sha: d.sha };
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			wrap(e, `fichier ${path}`);
		}
	}

	async listRunners(owner: string, repo: string): Promise<GhRunner[]> {
		try {
			const res = await this.#o.rest.actions.listSelfHostedRunnersForRepo({ owner, repo, per_page: 100 });
			return res.data.runners.map((r) => ({
				id: r.id,
				name: r.name,
				status: r.status === 'online' ? 'online' : 'offline',
				busy: r.busy,
				labels: r.labels.map((l) => l.name)
			}));
		} catch (e) {
			wrap(e, 'liste des runners');
		}
	}

	async listWorkflowRuns(owner: string, repo: string, workflowFile: string, perPage = 20) {
		try {
			const res = await this.#o.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: workflowFile, per_page: perPage });
			return res.data.workflow_runs.map((r) => toRun(r as RawRun));
		} catch (e) {
			if ((e as { status?: number }).status === 404) return [];
			wrap(e, 'historique des runs');
		}
	}

	async listRepoRuns(owner: string, repo: string, perPage = 5) {
		try {
			const res = await this.#o.rest.actions.listWorkflowRunsForRepo({ owner, repo, per_page: perPage });
			return res.data.workflow_runs.map((r) => toRun(r as RawRun));
		} catch (e) {
			if ((e as { status?: number }).status === 404) return [];
			wrap(e, 'derniers runs');
		}
	}

	async getRun(owner: string, repo: string, runId: number) {
		try {
			return toRun((await this.#o.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data as RawRun);
		} catch (e) {
			wrap(e, `run ${runId}`);
		}
	}

	async getRunJobs(owner: string, repo: string, runId: number): Promise<GhRunJob[]> {
		try {
			const res = await this.#o.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId });
			return res.data.jobs.map((j) => ({
				id: j.id,
				name: j.name,
				status: j.status,
				conclusion: j.conclusion,
				startedAt: j.started_at ?? null,
				completedAt: j.completed_at ?? null,
				steps: (j.steps ?? []).map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion }))
			}));
		} catch (e) {
			wrap(e, `jobs du run ${runId}`);
		}
	}

	async getJobLogs(owner: string, repo: string, jobId: number) {
		try {
			const res = await this.#o.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { owner, repo, job_id: jobId });
			return typeof res.data === 'string' ? res.data : String(res.data ?? '');
		} catch (e) {
			wrap(e, `logs du job ${jobId}`);
		}
	}

	async getPublicKey(owner: string, repo: string) {
		try {
			const res = await this.#o.rest.actions.getRepoPublicKey({ owner, repo });
			return { keyId: res.data.key_id, key: res.data.key };
		} catch (e) {
			wrap(e, 'clé publique des secrets');
		}
	}

	async getSecretMeta(owner: string, repo: string, name: string) {
		try {
			const res = await this.#o.rest.actions.getRepoSecret({ owner, repo, secret_name: name });
			return { updatedAt: res.data.updated_at };
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			wrap(e, `secret ${name}`);
		}
	}

	async listVariables(owner: string, repo: string) {
		try {
			const res = await this.#o.rest.actions.listRepoVariables({ owner, repo, per_page: 30 });
			return res.data.variables.map((v) => ({ name: v.name, value: v.value }));
		} catch (e) {
			wrap(e, 'variables du dépôt');
		}
	}

	async createRegistrationToken(owner: string, repo: string) {
		try {
			const res = await this.#o.rest.actions.createRegistrationTokenForRepo({ owner, repo });
			return { token: res.data.token, expiresAt: res.data.expires_at };
		} catch (e) {
			wrap(e, "jeton d'enregistrement du runner");
		}
	}

	async createRemoveToken(owner: string, repo: string) {
		try {
			const res = await this.#o.rest.actions.createRemoveTokenForRepo({ owner, repo });
			return { token: res.data.token, expiresAt: res.data.expires_at };
		} catch (e) {
			wrap(e, 'jeton de retrait du runner');
		}
	}

	async deleteRunner(owner: string, repo: string, runnerId: number) {
		try {
			await this.#o.rest.actions.deleteSelfHostedRunnerFromRepo({ owner, repo, runner_id: runnerId });
		} catch (e) {
			wrap(e, `retrait du runner ${runnerId}`);
		}
	}

	async putSecret(owner: string, repo: string, name: string, encryptedValue: string, keyId: string) {
		try {
			await this.#o.rest.actions.createOrUpdateRepoSecret({ owner, repo, secret_name: name, encrypted_value: encryptedValue, key_id: keyId });
		} catch (e) {
			wrap(e, `écriture du secret ${name}`);
		}
	}

	async deleteSecret(owner: string, repo: string, name: string) {
		try {
			await this.#o.rest.actions.deleteRepoSecret({ owner, repo, secret_name: name });
		} catch (e) {
			if ((e as { status?: number }).status === 404) return;
			wrap(e, `suppression du secret ${name}`);
		}
	}

	async setVariable(owner: string, repo: string, name: string, value: string): Promise<'created' | 'updated'> {
		try {
			await this.#o.rest.actions.updateRepoVariable({ owner, repo, name, value });
			return 'updated';
		} catch (e) {
			if ((e as { status?: number }).status !== 404) wrap(e, `variable ${name}`);
		}
		try {
			await this.#o.rest.actions.createRepoVariable({ owner, repo, name, value });
			return 'created';
		} catch (e) {
			wrap(e, `création de la variable ${name}`);
		}
	}

	async deleteVariable(owner: string, repo: string, name: string) {
		try {
			await this.#o.rest.actions.deleteRepoVariable({ owner, repo, name });
		} catch (e) {
			if ((e as { status?: number }).status === 404) return;
			wrap(e, `suppression de la variable ${name}`);
		}
	}

	async createFile(owner: string, repo: string, path: string, content: string, message: string, branch: string) {
		try {
			const res = await this.#o.rest.repos.createOrUpdateFileContents({
				owner,
				repo,
				path,
				message,
				branch,
				content: Buffer.from(content, 'utf8').toString('base64')
			});
			return { commitSha: res.data.commit.sha ?? '', contentSha: res.data.content?.sha ?? '' };
		} catch (e) {
			wrap(e, `commit de ${path}`);
		}
	}

	async updateFile(owner: string, repo: string, path: string, content: string, message: string, branch: string, sha: string) {
		try {
			const res = await this.#o.rest.repos.createOrUpdateFileContents({
				owner,
				repo,
				path,
				message,
				branch,
				sha,
				content: Buffer.from(content, 'utf8').toString('base64')
			});
			return { commitSha: res.data.commit.sha ?? '', contentSha: res.data.content?.sha ?? '' };
		} catch (e) {
			wrap(e, `mise à jour de ${path}`);
		}
	}

	async deleteFile(owner: string, repo: string, path: string, sha: string, message: string, branch: string) {
		try {
			await this.#o.rest.repos.deleteFile({ owner, repo, path, sha, message, branch });
		} catch (e) {
			if ((e as { status?: number }).status === 404) return;
			wrap(e, `suppression de ${path}`);
		}
	}

	async dispatchWorkflow(owner: string, repo: string, workflowFile: string, ref: string) {
		try {
			const res = await this.#o.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
				owner,
				repo,
				workflow_id: workflowFile,
				ref,
				return_run_details: true
			} as never);
			const data = (res as { data?: { workflow_run_id?: number; html_url?: string } }).data;
			return { runId: data?.workflow_run_id ?? null, htmlUrl: data?.html_url ?? null };
		} catch (e) {
			wrap(e, `lancement de ${workflowFile}`);
		}
	}
}

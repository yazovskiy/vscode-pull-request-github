/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import Octokit = require('@octokit/rest');
import { CredentialStore } from './credentials';
import { IComment } from '../common/comment';
import { Remote, parseRepositoryRemotes } from '../common/remote';
import { TimelineEvent, EventType, ReviewEvent as CommonReviewEvent, isReviewEvent, isCommitEvent } from '../common/timelineEvent';
import { GitHubRepository, PullRequestData } from './githubRepository';
import { IPullRequestsPagingOptions, PRType, ReviewEvent, IPullRequestEditData, PullRequest, IRawFileChange, IAccount, ILabel, RepoAccessAndMergeMethods } from './interface';
import { PullRequestGitHelper, PullRequestMetadata } from './pullRequestGitHelper';
import { PullRequestModel, IResolvedPullRequestModel } from './pullRequestModel';
import { GitHubManager } from '../authentication/githubServer';
import { formatError, uniqBy, Predicate, groupBy } from '../common/utils';
import { Repository, RefType, UpstreamRef } from '../api/api';
import Logger from '../common/logger';
import { EXTENSION_ID } from '../constants';
import { fromPRUri } from '../common/uri';
import { convertRESTPullRequestToRawPullRequest, convertPullRequestsGetCommentsResponseItemToComment, convertIssuesCreateCommentResponseToComment, parseGraphQLTimelineEvents, convertRESTTimelineEvents, getRelatedUsersFromTimelineEvents, parseGraphQLComment, getReactionGroup, convertRESTUserToAccount, convertRESTReviewEvent, parseGraphQLReviewEvent } from './utils';
import { PendingReviewIdResponse, TimelineEventsResponse, PullRequestCommentsResponse, AddCommentResponse, SubmitReviewResponse, DeleteReviewResponse, EditCommentResponse, DeleteReactionResponse, AddReactionResponse, MarkPullRequestReadyForReviewResponse, PullRequestState } from './graphql';
import { ITelemetry } from '../common/telemetry';
import { ApiImpl } from '../api/api1';
const queries = require('./queries.gql');

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean | null;
}

interface RestErrorResult {
	errors: RestError[];
	message: string;
}

interface RestError {
	code: string;
	field: string;
	resource: string;
}

interface PullRequestsResponseResult {
	pullRequests: PullRequestModel[];
	hasMorePages: boolean;
	hasUnsearchedRepositories: boolean;
}

export class NoGitHubReposError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has no GitHub remotes`;
	}
}

export class DetachedHeadError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has a detached HEAD (create a branch first)`;
	}
}

export class BadUpstreamError extends Error {
	constructor(
		public branchName: string,
		public upstreamRef: UpstreamRef,
		public problem: string) {
		super();
	}

	get message() {
		const { upstreamRef: { remote, name }, branchName, problem } = this;
		return `The upstream ref ${remote}/${name} for branch ${branchName} ${problem}.`;
	}
}

export const SETTINGS_NAMESPACE = 'githubPullRequests';
export const REMOTES_SETTING = 'remotes';

interface NewCommentPosition {
	path: string;
	position: number;
}

interface ReplyCommentPosition {
	inReplyTo: string;
}

export enum PRManagerState {
	Initializing,
	NeedsAuthentication,
	RepositoriesLoaded
}

export interface PullRequestDefaults {
	owner: string;
	repo: string;
	base: string;
}

export class PullRequestManager implements vscode.Disposable {
	static ID = 'PullRequestManager';

	private _subs: vscode.Disposable[];
	private _activePullRequest?: PullRequestModel;
	private _githubRepositories: GitHubRepository[];
	private _allGitHubRemotes: Remote[] = [];
	private _mentionableUsers?: { [key: string]: IAccount[] };
	private _fetchMentionableUsersPromise?: Promise<{ [key: string]: IAccount[] }>;
	private _gitBlameCache: { [key: string]: string } = {};
	private _githubManager: GitHubManager;
	private _repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();

	private _onDidChangeActivePullRequest = new vscode.EventEmitter<void>();
	readonly onDidChangeActivePullRequest: vscode.Event<void> = this._onDidChangeActivePullRequest.event;

	private _onDidChangeState = new vscode.EventEmitter<void>();
	readonly onDidChangeState: vscode.Event<void> = this._onDidChangeState.event;

	private _state: PRManagerState = PRManagerState.Initializing;

	constructor(
		private _repository: Repository,
		private readonly _telemetry: ITelemetry,
		private _git: ApiImpl,
		private _credentialStore: CredentialStore = new CredentialStore(_telemetry),
	) {
		this._subs = [];
		this._githubRepositories = [];
		this._githubManager = new GitHubManager();

		this._subs.push(this._credentialStore);
		this._subs.push(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${REMOTES_SETTING}`)) {
				await this.updateRepositories();
				vscode.commands.executeCommand('pr.refreshList');
			}
		}));

		this.setUpCompletionItemProvider();
		this.showLoginPrompt();
	}

	get state() {
		return this._state;
	}

	set state(state: PRManagerState) {
		const stateChange = state !== this._state;
		this._state = state;
		if (stateChange) {
			this._onDidChangeState.fire();
		}
	}

	// Check if the remotes are authenticated and show a prompt if not, but don't block on user's response
	private async showLoginPrompt(): Promise<void> {
		const activeRemotes = await this.getActiveRemotes();
		for (const server of uniqBy(activeRemotes, remote => remote.gitProtocol.normalizeUri()!.authority)) {
			this._credentialStore.hasOctokit(server).then(authd => {
				if (!authd) {
					this._credentialStore.loginWithConfirmation(server);
				}
			});
		}

		return Promise.resolve();
	}

	private computeAllGitHubRemotes(): Promise<Remote[]> {
		const remotes = parseRepositoryRemotes(this.repository);
		const potentialRemotes = remotes.filter(remote => remote.host);
		return Promise.all(potentialRemotes.map(remote => this._githubManager.isGitHub(remote.gitProtocol.normalizeUri()!)))
			.then(results => potentialRemotes.filter((_, index, __) => results[index]))
			.catch(e => {
				Logger.appendLine(`Resolving GitHub remotes failed: ${formatError(e)}`);
				vscode.window.showErrorMessage(`Resolving GitHub remotes failed: ${formatError(e)}`);
				return [];
			});
	}

	private async getActiveGitHubRemotes(allGitHubRemotes: Remote[]): Promise<Remote[]> {
		const remotesSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string[]>(REMOTES_SETTING);

		if (!remotesSetting) {
			Logger.appendLine(`Unable to read remotes setting`);
			return Promise.resolve([]);
		}

		remotesSetting.forEach(remote => {
			if (!allGitHubRemotes.some(repo => repo.remoteName === remote)) {
				Logger.appendLine(`No remote with name '${remote}' found. Please update your 'githubPullRequests.remotes' setting.`);
			}
		});

		Logger.debug(`Displaying configured remotes: ${remotesSetting.join(', ')}`, PullRequestManager.ID);

		return remotesSetting
			.map(remote => allGitHubRemotes.find(repo => repo.remoteName === remote))
			.filter((repo: Remote | undefined): repo is Remote => !!repo);
	}

	private setUpCompletionItemProvider() {
		let lastPullRequest: PullRequestModel | undefined = undefined;
		let lastPullRequestTimelineEvents: TimelineEvent[] = [];
		let cachedUsers: vscode.CompletionItem[] = [];

		vscode.languages.registerCompletionItemProvider({ scheme: 'comment' }, {
			provideCompletionItems: async (document, position, token) => {
				try {
					const query = JSON.parse(document.uri.query);
					if (query.extensionId !== EXTENSION_ID) {
						return;
					}

					const wordRange = document.getWordRangeAtPosition(position, /@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})?/i);
					if (!wordRange || wordRange.isEmpty) {
						return;
					}

					let prRelatedusers: { login: string; name?: string; }[] = [];
					const fileRelatedUsersNames: { [key: string]: boolean } = {};
					let mentionableUsers: { [key: string]: { login: string; name?: string; }[]; } = {};
					let prNumber: number | undefined;
					let remoteName: string | undefined;

					const activeTextEditors = vscode.window.visibleTextEditors;
					if (activeTextEditors.length) {
						const visibilePREditor = activeTextEditors.find(editor => editor.document.uri.scheme === 'pr');

						if (visibilePREditor) {
							const params = fromPRUri(visibilePREditor.document.uri);
							prNumber = params!.prNumber;
							remoteName = params!.remoteName;
						} else if (this._activePullRequest) {
							prNumber = this._activePullRequest.prNumber;
							remoteName = this._activePullRequest.remote.remoteName;
						}

						if (lastPullRequest && prNumber && prNumber === lastPullRequest.prNumber) {
							return cachedUsers;
						}
					}

					const prRelatedUsersPromise = new Promise(async resolve => {
						if (prNumber && remoteName) {
							Logger.debug('get Timeline Events and parse users', PullRequestManager.ID);
							if (lastPullRequest && lastPullRequest.prNumber === prNumber) {
								return lastPullRequestTimelineEvents;
							}

							const githubRepos = this._githubRepositories.filter(repo => repo.remote.remoteName === remoteName);

							if (githubRepos.length) {
								lastPullRequest = await githubRepos[0].getPullRequest(prNumber);
								lastPullRequestTimelineEvents = await this.getTimelineEvents(lastPullRequest!);
							}

							prRelatedusers = getRelatedUsersFromTimelineEvents(lastPullRequestTimelineEvents);
							resolve();
						}

						resolve();
					});

					const fileRelatedUsersNamesPromise = new Promise(async resolve => {
						if (activeTextEditors.length) {
							try {
								Logger.debug('git blame and parse users', PullRequestManager.ID);
								const fsPath = path.resolve(activeTextEditors[0].document.uri.fsPath);
								let blames: string | undefined;
								if (this._gitBlameCache[fsPath]) {
									blames = this._gitBlameCache[fsPath];
								} else {
									blames = await this.repository.blame(fsPath);
									this._gitBlameCache[fsPath] = blames;
								}

								const blameLines = blames.split('\n');

								for (const line in blameLines) {
									const matches = /^\w{11} \S*\s*\((.*)\s*\d{4}\-/.exec(blameLines[line]);

									if (matches && matches.length === 2) {
										const name = matches[1].trim();
										fileRelatedUsersNames[name] = true;
									}
								}
							} catch (err) {
								Logger.debug(err, PullRequestManager.ID);
							}
						}

						resolve();
					});

					const getMentionableUsersPromise = new Promise(async resolve => {
						Logger.debug('get mentionable users', PullRequestManager.ID);
						mentionableUsers = await this.getMentionableUsers();
						resolve();
					});

					await Promise.all([prRelatedUsersPromise, fileRelatedUsersNamesPromise, getMentionableUsersPromise]);

					cachedUsers = [];
					const prRelatedUsersMap: { [key: string]: { login: string; name?: string; } } = {};
					Logger.debug('prepare user suggestions', PullRequestManager.ID);

					prRelatedusers.forEach(user => {
						if (!prRelatedUsersMap[user.login]) {
							prRelatedUsersMap[user.login] = user;
						}
					});

					const secondMap: { [key: string]: boolean } = {};

					for (const mentionableUserGroup in mentionableUsers) {
						mentionableUsers[mentionableUserGroup].forEach(user => {
							if (!prRelatedUsersMap[user.login] && !secondMap[user.login]) {
								secondMap[user.login] = true;

								let priority = 2;
								if (fileRelatedUsersNames[user.login] || (user.name && fileRelatedUsersNames[user.name])) {
									priority = 1;
								}

								if (prRelatedUsersMap[user.login]) {
									priority = 0;
								}

								cachedUsers.push({
									label: `@${user.login}`,
									insertText: `${user.login}`,
									filterText: `${user.login}` + (user.name && user.name !== user.login ? `_${user.name.toLowerCase().replace(' ', '_')}` : ''),
									sortText: `${priority}_${user.login}`,
									detail: `${user.name}`
								});
							}
						});
					}

					for (const user in prRelatedUsersMap) {
						if (!secondMap[user]) {
							// if the mentionable api call fails partially, we should still populate related users from timeline events into the completion list
							cachedUsers.push({
								label: `@${prRelatedUsersMap[user].login}`,
								insertText: `${prRelatedUsersMap[user].login}`,
								filterText: `${prRelatedUsersMap[user].login}` + (prRelatedUsersMap[user].name && prRelatedUsersMap[user].name !== prRelatedUsersMap[user].login ? `_${prRelatedUsersMap[user].name!.toLowerCase().replace(' ', '_')}` : ''),
								sortText: `0_${prRelatedUsersMap[user].login}`,
								detail: `${prRelatedUsersMap[user].name}`
							});
						}
					}

					Logger.debug('done', PullRequestManager.ID);
					return cachedUsers;
				} catch (e) {
					return [];
				}
			}
		}, '@');

	}

	get activePullRequest(): (PullRequestModel | undefined) {
		return this._activePullRequest;
	}

	set activePullRequest(pullRequest: (PullRequestModel | undefined)) {
		this._activePullRequest = pullRequest;
		this._onDidChangeActivePullRequest.fire();
	}

	get repository(): Repository {
		return this._repository;
	}

	set repository(repository: Repository) {
		this._repository = repository;
	}

	get credentialStore(): CredentialStore {
		return this._credentialStore;
	}

	async clearCredentialCache(): Promise<void> {
		this._credentialStore.reset();
		this.state = PRManagerState.Initializing;
	}

	private async getActiveRemotes(): Promise<Remote[]> {
		this._allGitHubRemotes = await this.computeAllGitHubRemotes();
		const activeRemotes = await this.getActiveGitHubRemotes(this._allGitHubRemotes);

		if (activeRemotes.length) {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', true);
			Logger.appendLine('Found GitHub remote');
		} else {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', false);
			Logger.appendLine('No GitHub remotes found');
		}

		return activeRemotes;
	}

	async updateRepositories(): Promise<void> {
		if (this._git.state === 'uninitialized') {
			return;
		}

		const activeRemotes = await this.getActiveRemotes();

		const serverAuthPromises: Promise<boolean>[] = [];
		const authenticatedRemotes: Remote[] = [];

		const activeRemotesByAuthority = groupBy(activeRemotes, remote => remote.gitProtocol.normalizeUri()!.authority);
		for (const authority of Object.keys(activeRemotesByAuthority)) {
			const remotesForAuthority = activeRemotesByAuthority[authority];
			serverAuthPromises.push(this._credentialStore.hasOctokit(remotesForAuthority[0]).then(authd => {
				if (!authd) {
					return false;
				} else {
					authenticatedRemotes.push(...remotesForAuthority);
					return true;
				}
			}));
		}

		let hasAuthenticated = false;
		await Promise.all(serverAuthPromises).then(authenticationResult => {
			hasAuthenticated = authenticationResult.some(isAuthd => isAuthd);
			vscode.commands.executeCommand('setContext', 'github:authenticated', hasAuthenticated);
		}).catch(e => {
			Logger.appendLine(`serverAuthPromises failed: ${formatError(e)}`);
		});

		const repositories: GitHubRepository[] = [];
		const resolveRemotePromises: Promise<void>[] = [];

		authenticatedRemotes.forEach(remote => {
			const repository = this.createGitHubRepository(remote, this._credentialStore);
			resolveRemotePromises.push(repository.resolveRemote());
			repositories.push(repository);
		});

		return Promise.all(resolveRemotePromises).then(_ => {
			const oldRepositories = this._githubRepositories;
			this._githubRepositories = repositories;
			oldRepositories.forEach(repo => repo.dispose());

			const repositoriesChanged = oldRepositories.length !== this._githubRepositories.length
				|| !oldRepositories.every(oldRepo => this._githubRepositories.some(newRepo => newRepo.remote.equals(oldRepo.remote)));

			this.getMentionableUsers(repositoriesChanged);
			this.state = hasAuthenticated || !activeRemotes.length ? PRManagerState.RepositoriesLoaded : PRManagerState.NeedsAuthentication;
			return Promise.resolve();
		});
	}

	async getMentionableUsers(clearCache?: boolean): Promise<{ [key: string]: IAccount[] }> {
		if (clearCache) {
			delete this._mentionableUsers;
		}

		if (this._mentionableUsers) {
			return this._mentionableUsers;
		}

		if (!this._fetchMentionableUsersPromise) {
			const cache: { [key: string]: IAccount[] } = {};
			return this._fetchMentionableUsersPromise = new Promise((resolve) => {
				const promises = this._githubRepositories.map(async githubRepository => {
					const data = await githubRepository.getMentionableUsers();
					cache[githubRepository.remote.remoteName] = data;
					return;
				});

				Promise.all(promises).then(() => {
					this._mentionableUsers = cache;
					this._fetchMentionableUsersPromise = undefined;
					resolve(cache);
				});
			});
		}

		return this._fetchMentionableUsersPromise;
	}

	/**
	 * Returns the remotes that are currently active, which is those that are important by convention (origin, upstream),
	 * or the remotes configured by the setting githubPullRequests.remotes
	 */
	getGitHubRemotes(): Remote[] {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		return githubRepositories.map(repository => repository.remote);
	}

	/**
	 * Returns all remotes from the repository.
	 */
	getAllGitHubRemotes(): Remote[] {
		return this._allGitHubRemotes;
	}

	async authenticate(): Promise<boolean> {
		let wasSuccessful = false;
		const activeRemotes = await this.getActiveGitHubRemotes(this._allGitHubRemotes);

		const promises = uniqBy(activeRemotes, x => x.normalizedHost).map(async remote => {
			wasSuccessful = !!(await this._credentialStore.login(remote)) || wasSuccessful;
			return;
		});

		return Promise.all(promises).then(_ => {
			return wasSuccessful;
		});
	}

	async getLocalPullRequests(): Promise<PullRequestModel[]> {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		const localBranches = this.repository.state.refs
			.filter(r => r.type === RefType.Head && r.name !== undefined)
			.map(r => r.name!);

		const promises = localBranches.map(async localBranchName => {
			const matchingPRMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this.repository, localBranchName);

			if (matchingPRMetadata) {
				const { owner, prNumber } = matchingPRMetadata;
				const githubRepo = githubRepositories.find(repo => repo.remote.owner.toLocaleLowerCase() === owner.toLocaleLowerCase());

				if (githubRepo) {
					const pullRequest: PullRequestModel | undefined = await githubRepo.getPullRequest(prNumber);

					if (pullRequest) {
						pullRequest.localBranchName = localBranchName;
						return pullRequest;
					}
				}
			}

			return Promise.resolve(null);
		});

		return Promise.all(promises).then(values => {
			return values.filter(value => value !== null) as PullRequestModel[];
		});
	}

	async getLabels(pullRequest: PullRequestModel): Promise<ILabel[]> {
		const { remote, octokit } = await pullRequest.githubRepository.ensure();

		let hasNextPage = false;
		let page = 1;
		let results: ILabel[] = [];

		do {
			const result = await octokit.issues.listLabelsForRepo({
				owner: remote.owner,
				repo: remote.repositoryName,
				page
			});

			results = results.concat(result.data.map(label => {
				return {
					name: label.name,
					color: label.color
				};
			}));

			results = results.sort((a, b) => a.name.localeCompare(b.name));

			hasNextPage = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			page += 1;
		} while (hasNextPage);

		return results;
	}

	async deleteLocalPullRequest(pullRequest: PullRequestModel, force?: boolean): Promise<void> {
		if (!pullRequest.localBranchName) {
			return;
		}
		await this.repository.deleteBranch(pullRequest.localBranchName, force);

		let remoteName: string | undefined = undefined;
		try {
			remoteName = await this.repository.getConfig(`branch.${pullRequest.localBranchName}.remote`);
		} catch (e) { }

		if (!remoteName) {
			return;
		}

		// If the extension created a remote for the branch, remove it if there are no other branches associated with it
		const isPRRemote = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remoteName);
		if (isPRRemote) {
			const configs = await this.repository.getConfigs();
			const hasOtherAssociatedBranches = configs
				.some(({ key, value }) => /^branch.*\.remote$/.test(key) && value === remoteName);

			if (!hasOtherAssociatedBranches) {
				await this.repository.removeRemote(remoteName);
			}
		}

		/* __GDPR__
			"branch.delete" : {}
		*/
		this._telemetry.sendTelemetryEvent('branch.delete');
	}

	// Keep track of how many pages we've fetched for each query, so when we reload we pull the same ones.
	private totalFetchedPages = new Map<string, number>();

	/**
	 * This method works in three different ways:
	 * 1) Initialize: fetch the first page of the first remote that has pages
	 * 2) Fetch Next: fetch the next page from this remote, or if it has no more pages, the first page from the next remote that does have pages
	 * 3) Restore: fetch all the pages you previously have fetched
	 *
	 * When `options.fetchNextPage === false`, we are in case 2.
	 * Otherwise:
	 *   If `this.totalFetchQueries[queryId] === 0`, we are in case 1.
	 *   Otherwise, we're in case 3.
	 */
	async getPullRequests(type: PRType, options: IPullRequestsPagingOptions = { fetchNextPage: false }, query?: string): Promise<PullRequestsResponseResult> {
		if (!this._githubRepositories || !this._githubRepositories.length) {
			return {
				pullRequests: [],
				hasMorePages: false,
				hasUnsearchedRepositories: false
			};
		}

		const queryId = type.toString() + (query || '');
		const getTotalFetchedPages = () => this.totalFetchedPages.get(queryId) || 0;
		const setTotalFetchedPages = (numPages: number) => this.totalFetchedPages.set(queryId, numPages);

		for (const repository of this._githubRepositories) {
			const remoteId = repository.remote.url.toString() + queryId;
			if (!this._repositoryPageInformation.get(remoteId)) {
				this._repositoryPageInformation.set(remoteId, {
					pullRequestPage: 0,
					hasMorePages: null
				});
			}
		}

		let pagesFetched = 0;
		const pullRequestData: PullRequestData = { hasMorePages: false, pullRequests: [] };
		const addPage = (page: PullRequestData | undefined) => {
			pagesFetched++;
			if (page) {
				pullRequestData.pullRequests = pullRequestData.pullRequests.concat(page.pullRequests);
				pullRequestData.hasMorePages = page.hasMorePages;
			}
		};

		const githubRepositories = this._githubRepositories.filter(repo => {
			const info = this._repositoryPageInformation.get(repo.remote.url.toString() + queryId);
			// If we are in case 1 or 3, don't filter out repos that are out of pages, as we will be querying from the start.
			return info && (options.fetchNextPage === false || info.hasMorePages !== false);
		});

		for (let i = 0; i < githubRepositories.length; i++) {
			const githubRepository = githubRepositories[i];
			const remoteId = githubRepository.remote.url.toString() + queryId;
			const pageInformation = this._repositoryPageInformation.get(remoteId)!;

			const fetchPage = async (pageNumber: number) =>
				type === PRType.All
					? await githubRepository.getAllPullRequests(pageNumber)
					: await githubRepository.getPullRequestsForCategory(query || '', pageNumber);

			if (options.fetchNextPage) {
				// Case 2. Fetch a single new page, and increment the global number of pages fetched for this query.
				pageInformation.pullRequestPage++;
				addPage(await fetchPage(pageInformation.pullRequestPage));
				setTotalFetchedPages(getTotalFetchedPages() + 1);
			} else {
				// Case 1&3. Fetch all the pages we have fetched in the past, or in case 1, just a single page.

				if (pageInformation.pullRequestPage === 0) {
					// Case 1. Pretend we have previously fetched the first page, then hand off to the case 3 machinery to "fetch all pages we have fetched in the past"
					pageInformation.pullRequestPage = 1;
				}

				const pages = await Promise.all(
					Array.from({ length: pageInformation.pullRequestPage }).map((_, j) => fetchPage(j + 1)));
				pages.forEach(page => addPage(page));
			}

			pageInformation.hasMorePages = pullRequestData.hasMorePages;

			// Break early if
			// 1) we've received data AND
			// 2) either we're fetching just the next page (case 2)
			//    OR we're fetching all (cases 1&3), and we've fetched as far as we had previously (or further, in case 1).
			if (
				pullRequestData.pullRequests.length &&
				(options.fetchNextPage === true ||
					(options.fetchNextPage === false && pagesFetched >= getTotalFetchedPages()))
			) {
				if (getTotalFetchedPages() === 0) {
					// We're in case 1, manually set number of pages we looked through until we found first results.
					setTotalFetchedPages(pagesFetched);
				}

				return {
					pullRequests: pullRequestData.pullRequests,
					hasMorePages: pageInformation.hasMorePages,
					hasUnsearchedRepositories: i < githubRepositories.length - 1
				};
			}
		}

		return {
			pullRequests: [],
			hasMorePages: false,
			hasUnsearchedRepositories: false
		};
	}

	async getStatusChecks(pullRequest: PullRequestModel): Promise<Octokit.ReposGetCombinedStatusForRefResponse | undefined> {
		if (!pullRequest.isResolved()) {
			return;
		}

		const { remote, octokit } = await pullRequest.githubRepository.ensure();

		const result = await octokit.repos.getCombinedStatusForRef({
			owner: remote.owner,
			repo: remote.repositoryName,
			ref: pullRequest.head.sha
		});

		return result.data;
	}

	async getReviewRequests(pullRequest: PullRequestModel): Promise<IAccount[]> {
		const githubRepository = pullRequest.githubRepository;
		const { remote, octokit } = await githubRepository.ensure();
		const result = await octokit.pulls.listReviewRequests({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: pullRequest.prNumber
		});

		return result.data.users.map((user: any) => convertRESTUserToAccount(user, githubRepository));
	}

	async getPullRequestComments(pullRequest: PullRequestModel): Promise<IComment[]> {
		const { supportsGraphQl } = pullRequest.githubRepository;
		return supportsGraphQl
			? this.getAllPullRequestReviewComments(pullRequest)
			: this.getPullRequestReviewComments(pullRequest);
	}

	private async getAllPullRequestReviewComments(pullRequest: PullRequestModel): Promise<IComment[]> {
		const { remote, query } = await pullRequest.githubRepository.ensure();
		try {
			const { data } = await query<PullRequestCommentsResponse>({
				query: queries.PullRequestComments,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: pullRequest.prNumber,
				}
			});

			const comments = data.repository.pullRequest.reviews.nodes
				.map((node: any) => node.comments.nodes.map((comment: any) => parseGraphQLComment(comment), remote))
				.reduce((prev: any, curr: any) => prev.concat(curr), [])
				.sort((a: IComment, b: IComment) => { return a.createdAt > b.createdAt ? 1 : -1; });

			return comments;
		} catch (e) {
			Logger.appendLine(`Failed to get pull request review comments: ${formatError(e)}`);
			return [];
		}
	}

	/**
	 * Returns review comments from the pull request using the REST API, comments on pending reviews are not included.
	 */
	private async getPullRequestReviewComments(pullRequest: PullRequestModel): Promise<IComment[]> {
		Logger.debug(`Fetch comments of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const githubRepository = (pullRequest as PullRequestModel).githubRepository;
		const { remote, octokit } = await githubRepository.ensure();
		const reviewData = await octokit.pulls.listComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: pullRequest.prNumber,
			per_page: 100
		});
		Logger.debug(`Fetch comments of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

		return reviewData.data.map((comment: any) => this.addCommentPermissions(convertPullRequestsGetCommentsResponseItemToComment(comment, githubRepository), remote));
	}

	async getPullRequestCommits(pullRequest: PullRequestModel): Promise<Octokit.PullsListCommitsResponseItem[]> {
		try {
			Logger.debug(`Fetch commits of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
			const { remote, octokit } = await pullRequest.githubRepository.ensure();
			const commitData = await octokit.pulls.listCommits({
				pull_number: pullRequest.prNumber,
				owner: remote.owner,
				repo: remote.repositoryName
			});
			Logger.debug(`Fetch commits of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

			return commitData.data;
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commits failed: ${formatError(e)}`);
			return [];
		}
	}

	async getCommitChangedFiles(pullRequest: PullRequestModel, commit: Octokit.PullsListCommitsResponseItem): Promise<Octokit.ReposGetCommitResponseFilesItem[]> {
		try {
			Logger.debug(`Fetch file changes of commit ${commit.sha} in PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
			const { octokit, remote } = await pullRequest.githubRepository.ensure();
			const fullCommit = await octokit.repos.getCommit({
				owner: remote.owner,
				repo: remote.repositoryName,
				commit_sha: commit.sha
			});
			Logger.debug(`Fetch file changes of commit ${commit.sha} in PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

			return fullCommit.data.files.filter(file => !!file.patch);
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit file changes failed: ${formatError(e)}`);
			return [];
		}
	}

	async getFile(pullRequest: PullRequestModel, filePath: string, commit: string) {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		const fileContent = await octokit.repos.getContents({
			owner: remote.owner,
			repo: remote.repositoryName,
			path: filePath,
			ref: commit
		});

		const contents = fileContent.data.content;
		const buff = new Buffer(contents, fileContent.data.encoding);
		return buff.toString();
	}

	async getTimelineEvents(pullRequest: PullRequestModel): Promise<TimelineEvent[]> {
		Logger.debug(`Fetch timeline events of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const githubRepository = pullRequest.githubRepository;
		const { octokit, query, remote, supportsGraphQl } = await githubRepository.ensure();

		let ret = [];
		if (supportsGraphQl) {
			try {
				const { data } = await query<TimelineEventsResponse>({
					query: queries.TimelineEvents,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						number: pullRequest.prNumber
					}
				});
				ret = data.repository.pullRequest.timelineItems.nodes;
				const events = parseGraphQLTimelineEvents(ret, githubRepository);
				await this.addReviewTimelineEventComments(pullRequest, events);

				return events;
			} catch (e) {
				console.log(e);
				return [];
			}
		} else {
			ret = (await octokit.issues.listEventsForTimeline({
				owner: remote.owner,
				repo: remote.repositoryName,
				issue_number: pullRequest.prNumber,
				per_page: 100
			})).data;
			Logger.debug(`Fetch timeline events of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);
			return convertRESTTimelineEvents(await this.parseRESTTimelineEvents(pullRequest, remote, ret));
		}
	}

	async getIssueComments(pullRequest: PullRequestModel): Promise<Octokit.IssuesListCommentsResponseItem[]> {
		Logger.debug(`Fetch issue comments of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const promise = await octokit.issues.listComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: pullRequest.prNumber,
			per_page: 100
		});
		Logger.debug(`Fetch issue comments of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

		return promise.data;
	}

	async createIssueComment(pullRequest: PullRequestModel, text: string): Promise<IComment> {
		const githubRepository = pullRequest.githubRepository;
		const { octokit, remote } = await githubRepository.ensure();

		const promise = await octokit.issues.createComment({
			body: text,
			issue_number: pullRequest.prNumber,
			owner: remote.owner,
			repo: remote.repositoryName
		});

		return this.addCommentPermissions(convertIssuesCreateCommentResponseToComment(promise.data, githubRepository), remote);
	}

	async createCommentReply(pullRequest: PullRequestModel, body: string, reply_to: IComment): Promise<IComment | undefined> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		if (pendingReviewId) {
			return this.addCommentToPendingReview(pullRequest, pendingReviewId, body, { inReplyTo: reply_to.graphNodeId });
		}

		const githubRepository = pullRequest.githubRepository;
		const { octokit, remote } = await githubRepository.ensure();

		try {
			const ret = await octokit.pulls.createCommentReply({
				owner: remote.owner,
				repo: remote.repositoryName,
				pull_number: pullRequest.prNumber,
				body: body,
				in_reply_to: Number(reply_to.id)
			});

			return this.addCommentPermissions(convertPullRequestsGetCommentsResponseItemToComment(ret.data, githubRepository), remote);
		} catch (e) {
			this.handleError(e);
		}
	}

	async deleteReview(pullRequest: PullRequestModel): Promise<{ deletedReviewId: number, deletedReviewComments: IComment[] }> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<DeleteReviewResponse>({
			mutation: queries.DeleteReview,
			variables: {
				input: { pullRequestReviewId: pendingReviewId }
			}
		});

		const { comments, databaseId } = data!.deletePullRequestReview.pullRequestReview;

		pullRequest.inDraftMode = false;
		await this.updateDraftModeContext(pullRequest);

		return {
			deletedReviewId: databaseId,
			deletedReviewComments: comments.nodes.map(parseGraphQLComment)
		};
	}

	async startReview(pullRequest: PullRequestModel): Promise<void> {
		const { mutate } = await pullRequest.githubRepository.ensure();
		await mutate<void>({
			mutation: queries.StartReview,
			variables: {
				input: {
					body: '',
					pullRequestId: pullRequest.prItem.graphNodeId
				}
			}
		}).then(x => x.data).catch(e => {
			Logger.appendLine(`Failed to start review: ${e.message}`);
		});

		pullRequest.inDraftMode = true;
		await this.updateDraftModeContext(pullRequest);

		return;
	}

	async validateDraftMode(pullRequest: PullRequestModel): Promise<boolean> {
		const inDraftMode = !!await this.getPendingReviewId(pullRequest);
		if (inDraftMode !== pullRequest.inDraftMode) {
			pullRequest.inDraftMode = inDraftMode;
		}

		await this.updateDraftModeContext(pullRequest);

		return inDraftMode;
	}

	async updateDraftModeContext(pullRequest: PullRequestModel) {
		if (this._activePullRequest && this._activePullRequest.prNumber === pullRequest.prNumber) {
			await vscode.commands.executeCommand('setContext', 'reviewInDraftMode', pullRequest.inDraftMode);
		}
	}

	async getPendingReviewId(pullRequest = this._activePullRequest): Promise<string | undefined> {
		if (!pullRequest) {
			return undefined;
		}

		if (!pullRequest.githubRepository.supportsGraphQl) {
			return;
		}

		const { query, octokit } = await pullRequest.githubRepository.ensure();
		const { currentUser = '' } = octokit as any;
		try {
			const { data } = await query<PendingReviewIdResponse>({
				query: queries.GetPendingReviewId,
				variables: {
					pullRequestId: (pullRequest as PullRequestModel).prItem.graphNodeId,
					author: currentUser.login
				}
			});
			return data.node.reviews.nodes[0].id;
		} catch (error) {
			return;
		}
	}

	async addCommentToPendingReview(pullRequest: PullRequestModel, reviewId: string, body: string, position: NewCommentPosition | ReplyCommentPosition): Promise<IComment> {
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<AddCommentResponse>({
			mutation: queries.AddComment,
			variables: {
				input: {
					pullRequestReviewId: reviewId,
					body,
					...position
				}
			}
		});

		const { comment } = data!.addPullRequestReviewComment;
		return parseGraphQLComment(comment);
	}

	async addCommentReaction(pullRequest: PullRequestModel, graphNodeId: string, reaction: vscode.CommentReaction): Promise<AddReactionResponse> {
		const reactionEmojiToContent = getReactionGroup().reduce((prev, curr) => {
			prev[curr.label] = curr.title;
			return prev;
		}, {} as { [key: string]: string });
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<AddReactionResponse>({
			mutation: queries.AddReaction,
			variables: {
				input: {
					subjectId: graphNodeId,
					content: reactionEmojiToContent[reaction.label!]
				}
			}
		});

		return data!;
	}

	async deleteCommentReaction(pullRequest: PullRequestModel, graphNodeId: string, reaction: vscode.CommentReaction): Promise<DeleteReactionResponse> {
		const reactionEmojiToContent = getReactionGroup().reduce((prev, curr) => {
			prev[curr.label] = curr.title;
			return prev;
		}, {} as { [key: string]: string });
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<DeleteReactionResponse>({
			mutation: queries.DeleteReaction,
			variables: {
				input: {
					subjectId: graphNodeId,
					content: reactionEmojiToContent[reaction.label!]
				}
			}
		});

		return data!;
	}

	async createComment(pullRequest: PullRequestModel, body: string, commentPath: string, position: number): Promise<IComment | undefined> {
		if (!pullRequest.validatePullRequestModel('Creating comment failed')) {
			return;
		}

		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		if (pendingReviewId) {
			return this.addCommentToPendingReview(pullRequest, pendingReviewId, body, { path: commentPath, position });
		}

		const githubRepository = pullRequest.githubRepository;
		const { octokit, remote } = await githubRepository.ensure();

		try {
			const ret = await octokit.pulls.createComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				pull_number: pullRequest.prNumber,
				body: body,
				commit_id: pullRequest.head.sha,
				path: commentPath,
				position: position
			});

			return this.addCommentPermissions(convertPullRequestsGetCommentsResponseItemToComment(ret.data, githubRepository), remote);
		} catch (e) {
			this.handleError(e);
		}
	}

	async getPullRequestTemplates(): Promise<vscode.Uri[]> {
		/**
		 * Places a PR template can be:
		 * - At the root, the docs folder, or the.github folder, named pull_request_template.md or PULL_REQUEST_TEMPLATE.md
		 * - At the same folder locations under a PULL_REQUEST_TEMPLATE folder with any name
		 */
		const templatesPattern1 = await vscode.workspace.findFiles(new vscode.RelativePattern(this._repository.rootUri.path, '{pull_request_template,PULL_REQUEST_TEMPLATE}.md'));
		const templatesPattern2 = await vscode.workspace.findFiles(new vscode.RelativePattern(this._repository.rootUri.path, '{docs,.github}/{pull_request_template,PULL_REQUEST_TEMPLATE}.md'));

		const templatesPattern3 = await vscode.workspace.findFiles(new vscode.RelativePattern(this._repository.rootUri.path, 'PULL_REQUEST_TEMPLATE/*.md'));
		const templatesPattern4 = await vscode.workspace.findFiles(new vscode.RelativePattern(this._repository.rootUri.path, '{docs,.github}/PULL_REQUEST_TEMPLATE/*.md'));

		return [...templatesPattern1, ...templatesPattern2, ...templatesPattern3, ...templatesPattern4];
	}

	async getPullRequestDefaults(): Promise<PullRequestDefaults> {
		if (!this.repository.state.HEAD) {
			throw new DetachedHeadError(this.repository);
		}
		const { origin } = this;
		const meta = await origin.getMetadata();
		const parent = meta.fork
			? meta.parent
			: await (this.findRepo(byRemoteName('upstream')) || origin).getMetadata();

		return {
			owner: parent.owner.login,
			repo: parent.name,
			base: parent.default_branch
		};
	}

	async getMetadata(remote: string): Promise<any> {
		const repo = this.findRepo(byRemoteName(remote));
		return repo && repo.getMetadata();
	}

	async getHeadCommitMessage(): Promise<string> {
		const { repository } = this;
		if (repository.state.HEAD && repository.state.HEAD.commit) {
			const { message } = await repository.getCommit(repository.state.HEAD.commit);
			return message;
		}

		return '';
	}

	get origin(): GitHubRepository {
		if (!this._githubRepositories.length) {
			throw new NoGitHubReposError(this.repository);
		}

		const { upstreamRef } = this;
		if (upstreamRef) {
			// If our current branch has an upstream ref set, find its GitHubRepository.
			const upstream = this.findRepo(byRemoteName(upstreamRef.remote));
			if (!upstream) {
				vscode.window.showErrorMessage(`Unable to find upstream remote '${upstreamRef.remote}'. Please check your remotes setting.`, 'Configure Remotes').then(result => {
					if (result === 'Configure Remotes') {
						vscode.commands.executeCommand('pr.configureRemotes');
					}
				});

				// No GitHubRepository? We currently won't try pushing elsewhere,
				// so fail.
				throw new BadUpstreamError(
					this.repository.state.HEAD!.name!,
					upstreamRef,
					'is not a GitHub repo');
			}
			// Otherwise, we'll push upstream.
			return upstream;
		}

		// If no upstream is set, let's go digging.
		const [first, ...rest] = this._githubRepositories;
		return !rest.length  // Is there only one GitHub remote?
			? first // I GUESS THAT'S WHAT WE'RE GOING WITH, THEN.
			:  // Otherwise, let's try...
			this.findRepo(byRemoteName('origin')) || // by convention
			this.findRepo(ownedByMe) ||              // bc maybe we can push there
			first; // out of raw desperation
	}

	findRepo(where: Predicate<GitHubRepository>): GitHubRepository | undefined {
		return this._githubRepositories.filter(where)[0];
	}

	get upstreamRef(): UpstreamRef | undefined {
		const { HEAD } = this.repository.state;
		return HEAD && HEAD.upstream;
	}

	async createPullRequest(params: Octokit.PullsCreateParams): Promise<PullRequestModel | undefined> {
		try {
			const repo = this._githubRepositories.find(r => r.remote.owner === params.owner && r.remote.repositoryName === params.repo);
			if (!repo) {
				throw new Error(`No matching repository ${params.repo} found for ${params.owner}`);
			}

			await repo.ensure();

			const { title, body } = titleAndBodyFrom(await this.getHeadCommitMessage());
			if (!params.title) {
				params.title = title;
			}

			if (!params.body) {
				params.body = body;
			}

			// Create PR
			const { data } = await repo.octokit.pulls.create(params);
			const item = convertRESTPullRequestToRawPullRequest(data, repo);
			const pullRequestModel = new PullRequestModel(repo, repo.remote, item);

			const branchNameSeparatorIndex = params.head.indexOf(':');
			const branchName = params.head.slice(branchNameSeparatorIndex + 1);
			await PullRequestGitHelper.associateBranchWithPullRequest(this._repository, pullRequestModel, branchName);

			/* __GDPR__
				"pr.create.success" : {
					"isDraft" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this._telemetry.sendTelemetryEvent('pr.create.success', { isDraft: (params.draft || '').toString() });
			return pullRequestModel;
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Creating pull requests failed: ${formatError(e)}`);

			/* __GDPR__
				"pr.create.failure" : {
					"isDraft" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
					"message" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
				}
			*/
			this._telemetry.sendTelemetryEvent('pr.create.failure', {
				isDraft: (params.draft || '').toString(),
				message: formatError(e)
			});
			vscode.window.showWarningMessage(`Creating pull requests for '${params.head}' failed: ${formatError(e)}`);
		}
	}

	async editIssueComment(pullRequest: PullRequestModel, commentId: string, text: string): Promise<IComment> {
		try {
			const githubRepository = pullRequest.githubRepository;
			const { octokit, remote } = await githubRepository.ensure();

			const ret = await octokit.issues.updateComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				body: text,
				comment_id: Number(commentId)
			});

			return this.addCommentPermissions(convertIssuesCreateCommentResponseToComment(ret.data, githubRepository), remote);
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async editReviewComment(pullRequest: PullRequestModel, comment: IComment, text: string): Promise<IComment> {
		try {
			if (comment.isDraft) {
				return this.editPendingReviewComment(pullRequest, comment.graphNodeId, text);
			}

			const githubRepository = pullRequest.githubRepository;
			const { octokit, remote } = await githubRepository.ensure();

			const ret = await octokit.pulls.updateComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				body: text,
				comment_id: comment.id
			});

			return this.addCommentPermissions(convertPullRequestsGetCommentsResponseItemToComment(ret.data, githubRepository), remote);
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async editPendingReviewComment(pullRequest: PullRequestModel, commentNodeId: string, text: string): Promise<IComment> {
		const { mutate } = await pullRequest.githubRepository.ensure();

		const { data } = await mutate<EditCommentResponse>({
			mutation: queries.EditComment,
			variables: {
				input: {
					pullRequestReviewCommentId: commentNodeId,
					body: text
				}
			}
		});

		return parseGraphQLComment(data!.updatePullRequestReviewComment.pullRequestReviewComment);
	}

	async deleteIssueComment(pullRequest: PullRequestModel, commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			await octokit.issues.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteReviewComment(pullRequest: PullRequestModel, commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			await octokit.pulls.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	canEditPullRequest(pullRequest: PullRequestModel): boolean {
		const username = pullRequest.author && pullRequest.author.login;
		return this._credentialStore.isCurrentUser(username, pullRequest.remote);
	}

	getCurrentUser(pullRequest: PullRequestModel): IAccount {
		return convertRESTUserToAccount(this._credentialStore.getCurrentUser(pullRequest.remote), pullRequest.githubRepository);
	}

	private addCommentPermissions(rawComment: IComment, remote: Remote): IComment {
		const isCurrentUser = this._credentialStore.isCurrentUser(rawComment.user!.login, remote);
		const notOutdated = rawComment.position !== null;
		rawComment.canEdit = isCurrentUser && notOutdated;
		rawComment.canDelete = isCurrentUser && notOutdated;

		return rawComment;
	}

	private async changePullRequestState(state: 'open' | 'closed', pullRequest: PullRequestModel): Promise<[Octokit.PullsUpdateResponse, GitHubRepository]> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const ret = await octokit.pulls.update({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: pullRequest.prNumber,
			state: state
		});

		return [ret.data, pullRequest.githubRepository];
	}

	async editPullRequest(pullRequest: PullRequestModel, toEdit: IPullRequestEditData): Promise<Octokit.PullsUpdateResponse> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();
			const { data } = await octokit.pulls.update({
				owner: remote.owner,
				repo: remote.repositoryName,
				pull_number: pullRequest.prNumber,
				body: toEdit.body,
				title: toEdit.title
			});
			return data;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async closePullRequest(pullRequest: PullRequestModel): Promise<PullRequest> {
		return this.changePullRequestState('closed', pullRequest)
			.then(x => {
				/* __GDPR__
					"pr.close" : {}
				*/
				this._telemetry.sendTelemetryEvent('pr.close');
				return convertRESTPullRequestToRawPullRequest(x[0], x[1]);
			});
	}

	async mergePullRequest(pullRequest: PullRequestModel, title?: string, description?: string, method?: 'merge' | 'squash' | 'rebase'): Promise<any> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const activePRSHA = this.activePullRequest && this.activePullRequest.head && this.activePullRequest.head.sha;
		const workingDirectorySHA = this.repository.state.HEAD && this.repository.state.HEAD.commit;
		const mergingPRSHA = pullRequest.head && pullRequest.head.sha;
		const workingDirectoryIsDirty = this.repository.state.workingTreeChanges.length > 0;

		if (activePRSHA === mergingPRSHA) {
			// We're on the branch of the pr being merged.

			if (workingDirectorySHA !== mergingPRSHA) {
				// We are looking at different commit than what will be merged
				const { ahead } = this.repository.state.HEAD!;
				if (ahead &&
					await vscode.window.showWarningMessage(
						`You have ${ahead} unpushed ${ahead > 1 ? 'commits' : 'commit'} on this PR branch.\n\nWould you like to proceed anyways?`,
						{ modal: true },
						'Yes') === undefined
				) {
					return {
						merged: false,
						message: 'unpushed changes'
					};
				}
			}

			if (workingDirectoryIsDirty) {
				// We have made changes to the PR that are not committed
				if (await vscode.window.showWarningMessage(
					'You have uncommitted changes on this PR branch.\n\n Would you like to proceed anyways?', { modal: true }, 'Yes') === undefined) {
					return {
						merged: false,
						message: 'uncommitted changes'
					};
				}
			}
		}

		return await octokit.pulls.merge({
			commit_message: description,
			commit_title: title,
			merge_method: method || vscode.workspace.getConfiguration('githubPullRequests').get<'merge' | 'squash' | 'rebase'>('defaultMergeMethod'),
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: pullRequest.prNumber,
		})
			.then(x => {
				/* __GDPR__
					"pr.merge.success" : {}
				*/
				this._telemetry.sendTelemetryEvent('pr.merge.success');
				return x.data;
			}).catch(e => {
				/* __GDPR__
					"pr.merge.failure" : {
						"message" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
					}
				*/
				this._telemetry.sendTelemetryEvent('pr.merge.failure', { message: formatError(e) });
				throw e;
			});
	}

	async deleteBranch(pullRequest: PullRequestModel) {
		await pullRequest.githubRepository.deleteBranch(pullRequest);
	}

	private async getBranchDeletionItems() {
		const allConfigs = await this.repository.getConfigs();
		const branchInfos: Map<string, { remote?: string; metadata?: PullRequestMetadata }> = new Map();

		allConfigs.forEach(config => {
			const key = config.key;
			const matches = /^branch\.(.*)\.(.*)$/.exec(key);

			if (matches && matches.length === 3) {
				const branchName = matches[1];

				if (!branchInfos.has(branchName)) {
					branchInfos.set(branchName, {});
				}

				const value = branchInfos.get(branchName);
				if (matches[2] === 'remote') {
					value!['remote'] = config.value;
				}

				if (matches[2] === 'github-pr-owner-number') {
					const metadata = PullRequestGitHelper.parsePullRequestMetadata(config.value);
					value!['metadata'] = metadata;
				}

				branchInfos.set(branchName, value!);
			}
		});

		const actions: (vscode.QuickPickItem & { metadata: PullRequestMetadata, legacy?: boolean })[] = [];
		branchInfos.forEach((value, key) => {
			if (value.metadata) {
				actions.push({
					label: `${key}`,
					description: `${value.metadata!.repositoryName}/${value.metadata!.owner} #${value.metadata.prNumber}`,
					picked: false,
					metadata: value.metadata!
				});
			}
		});

		const results = await Promise.all(actions.map(async action => {
			const metadata = action.metadata;
			const githubRepo = this._githubRepositories.find(repo =>
				repo.remote.owner.toLowerCase() === metadata!.owner.toLowerCase() && repo.remote.repositoryName.toLowerCase() === metadata!.repositoryName.toLowerCase()
			);

			if (!githubRepo) {
				return action;
			}

			const { remote, query } = await githubRepo.ensure();
			try {
				const { data } = await query<PullRequestState>({
					query: queries.PullRequestState,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						number: metadata!.prNumber,
					}
				});

				action.legacy = data.repository.pullRequest.state !== 'OPEN';
			} catch { }

			return action;
		}));

		results.forEach(result => {
			if (result.legacy) {
				result.picked = true;
			} else {
				result.description = result.description + ' is still Open';
			}
		});

		return results;
	}

	private async getRemoteDeletionItems() {
		// check if there are remotes that should be cleaned
		const newConfigs = await this.repository.getConfigs();
		const remoteInfos: Map<string, { branches: Set<string>; url?: string; createdForPullRequest?: boolean }> = new Map();

		newConfigs.forEach(config => {
			const key = config.key;
			let matches = /^branch\.(.*)\.(.*)$/.exec(key);

			if (matches && matches.length === 3) {
				const branchName = matches[1];

				if (matches[2] === 'remote') {
					const remoteName = config.value;

					if (!remoteInfos.has(remoteName)) {
						remoteInfos.set(remoteName, { branches: new Set() });
					}

					const value = remoteInfos.get(remoteName);
					value!.branches.add(branchName);
				}
			}

			matches = /^remote\.(.*)\.(.*)$/.exec(key);

			if (matches && matches.length === 3) {
				const remoteName = matches[1];

				if (!remoteInfos.has(remoteName)) {
					remoteInfos.set(remoteName, { branches: new Set() });
				}

				const value = remoteInfos.get(remoteName);

				if (matches[2] === 'github-pr-remote') {
					value!.createdForPullRequest = config.value === 'true';
				}

				if (matches[2] === 'url') {
					value!.url = config.value;
				}

			}
		});

		const remoteItems: (vscode.QuickPickItem & { remote: string })[] = [];

		remoteInfos.forEach((value, key) => {
			if (value.branches.size === 0) {
				let description = value.createdForPullRequest ? '' : 'Not created by GitHub Pull Request extension';
				if (value.url) {
					description = description ? (description + ' ' + value.url) : value.url;
				}

				remoteItems.push({
					label: key,
					description: description,
					picked: value.createdForPullRequest,
					remote: key
				});
			}
		});

		return remoteItems;
	}

	async deleteLocalBranchesNRemotes() {
		return new Promise(async resolve => {
			const quickPick = vscode.window.createQuickPick();
			quickPick.canSelectMany = true;
			quickPick.ignoreFocusOut = true;
			quickPick.placeholder = 'Choose local branches you want to delete permanently';
			quickPick.show();
			quickPick.busy = true;

			// Check local branches
			const results = await this.getBranchDeletionItems();
			quickPick.items = results;
			quickPick.selectedItems = results.filter(result => result.picked);
			quickPick.busy = false;

			let firstStep = true;
			quickPick.onDidAccept(async () => {
				if (firstStep) {
					const picks = quickPick.selectedItems;
					if (picks.length) {
						quickPick.busy = true;
						await Promise.all(picks.map(async pick => {
							await this.repository.deleteBranch(pick.label, true);
						}));
						quickPick.busy = false;
					}

					firstStep = false;
					quickPick.busy = true;

					const remoteItems = await this.getRemoteDeletionItems();

					if (remoteItems) {
						quickPick.placeholder = 'Choose remotes you want to delete permanently';
						quickPick.busy = false;
						quickPick.items = remoteItems;
						quickPick.selectedItems = remoteItems.filter(item => item.picked);
					} else {
						quickPick.hide();
					}
				} else {
					// delete remotes
					const picks = quickPick.selectedItems;
					if (picks.length) {
						quickPick.busy = true;
						await Promise.all(picks.map(async pick => {
							await this.repository.removeRemote(pick.label);
						}));
						quickPick.busy = false;
					}
					quickPick.hide();
				}
			});

			quickPick.onDidHide(() => {
				resolve();
			});
		});
	}

	async setReadyForReview(pullRequest: PullRequestModel): Promise<any> {
		try {
			if (!pullRequest.githubRepository.supportsGraphQl) {
				// currently the REST api doesn't support updating PR draft status
				vscode.window.showWarningMessage('"Ready for Review" operation failed: requires GitHub GraphQL API support');
				return;
			}

			const { mutate } = await pullRequest.githubRepository.ensure();

			const { data } = await mutate<MarkPullRequestReadyForReviewResponse>({
				mutation: queries.ReadyForReview,
				variables: {
					input: {
						pullRequestId: pullRequest.graphNodeId,
					}
				}
			});

			/* __GDPR__
				"pr.readyForReview.success" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.readyForReview.success');

			return data!.markPullRequestReadyForReview.pullRequest.isDraft;
		} catch (e) {
			/* __GDPR__
				"pr.readyForReview.failure" : {
					"message" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
				}
			*/
			this._telemetry.sendTelemetryEvent('pr.readyForReview.failure', { message: formatError(e) });
			throw e;
		}
	}

	private async createReview(pullRequest: PullRequestModel, event: ReviewEvent, message?: string): Promise<CommonReviewEvent> {
		const githubRepository = pullRequest.githubRepository;
		const { octokit, remote } = await githubRepository.ensure();

		const { data } = await octokit.pulls.createReview({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: pullRequest.prNumber,
			event: event,
			body: message,
		});

		return convertRESTReviewEvent(data, githubRepository);
	}

	public async submitReview(pullRequest: PullRequestModel, event?: ReviewEvent, body?: string): Promise<CommonReviewEvent> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		const githubRepository = pullRequest.githubRepository;
		const { mutate } = await githubRepository.ensure();

		if (pendingReviewId) {
			const { data } = await mutate<SubmitReviewResponse>({
				mutation: queries.SubmitReview,
				variables: {
					id: pendingReviewId,
					event: event || ReviewEvent.Comment,
					body
				}
			});

			pullRequest.inDraftMode = false;
			await this.updateDraftModeContext(pullRequest);

			return parseGraphQLReviewEvent(data!.submitPullRequestReview.pullRequestReview, githubRepository);
		} else {
			throw new Error(`Submitting review failed, no pending review for current pull request: ${pullRequest.prNumber}.`);
		}
	}

	async requestChanges(pullRequest: PullRequestModel, message?: string): Promise<CommonReviewEvent> {
		const action: Promise<CommonReviewEvent> = await this.getPendingReviewId(pullRequest)
			? this.submitReview(pullRequest, ReviewEvent.RequestChanges, message)
			: this.createReview(pullRequest, ReviewEvent.RequestChanges, message);

		return action
			.then(x => {
				/* __GDPR__
					"pr.requestChanges" : {}
				*/
				this._telemetry.sendTelemetryEvent('pr.requestChanges');
				return x;
			});
	}

	async approvePullRequest(pullRequest: PullRequestModel, message?: string): Promise<CommonReviewEvent> {
		const action: Promise<CommonReviewEvent> = await this.getPendingReviewId(pullRequest)
			? this.submitReview(pullRequest, ReviewEvent.Approve, message)
			: this.createReview(pullRequest, ReviewEvent.Approve, message);

		return action.then(x => {
			/* __GDPR__
				"pr.approve" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.approve');
			return x;
		});
	}

	async getPullRequestFileChangesInfo(pullRequest: PullRequestModel & IResolvedPullRequestModel): Promise<IRawFileChange[]> {
		Logger.debug(`Fetch file changes, base, head and merge base of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const githubRepository = pullRequest.githubRepository;
		const { octokit, remote } = await githubRepository.ensure();

		if (!pullRequest.base) {
			const info = await octokit.pulls.get({
				owner: remote.owner,
				repo: remote.repositoryName,
				pull_number: pullRequest.prNumber
			});
			pullRequest.update(convertRESTPullRequestToRawPullRequest(info.data, githubRepository));
		}

		const { data } = await octokit.repos.compareCommits({
			repo: remote.repositoryName,
			owner: remote.owner,
			base: `${pullRequest.base.repositoryCloneUrl.owner}:${encodeURIComponent(pullRequest.base.ref)}`,
			head: `${pullRequest.head.repositoryCloneUrl.owner}:${encodeURIComponent(pullRequest.head.ref)}`
		});

		pullRequest.mergeBase = data.merge_base_commit.sha;

		Logger.debug(`Fetch file changes and merge base of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);
		return data.files;
	}

	/**
	 * Add reviewers to a pull request
	 * @param pullRequest The pull request
	 * @param reviewers A list of GitHub logins
	 */
	async requestReview(pullRequest: PullRequestModel, reviewers: string[]): Promise<void> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		await octokit.pulls.createReviewRequest({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: pullRequest.prNumber,
			reviewers
		});
	}

	async deleteRequestedReview(pullRequest: PullRequestModel, reviewer: string): Promise<void> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		await octokit.pulls.deleteReviewRequest({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: pullRequest.prNumber,
			reviewers: [reviewer]
		});
	}

	async addLabels(pullRequest: PullRequestModel, labels: string[]): Promise<void> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		await octokit.issues.addLabels({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: pullRequest.prNumber,
			labels
		});
	}

	async removeLabel(pullRequest: PullRequestModel, label: string): Promise<void> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		await octokit.issues.removeLabel({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: pullRequest.prNumber,
			name: label
		});
	}

	async getPullRequestRepositoryDefaultBranch(pullRequest: PullRequestModel): Promise<string> {
		const branch = await pullRequest.githubRepository.getDefaultBranch();
		return branch;
	}

	async getPullRequestRepositoryAccessAndMergeMethods(pullRequest: PullRequestModel): Promise<RepoAccessAndMergeMethods> {
		const mergeOptions = await pullRequest.githubRepository.getRepoAccessAndMergeMethods();
		return mergeOptions;
	}

	async fullfillPullRequestMissingInfo(pullRequest: PullRequestModel): Promise<void> {
		try {
			if (!pullRequest.isResolved()) {
				return;
			}

			Logger.debug(`Fullfill pull request missing info - start`, PullRequestManager.ID);
			const githubRepository = pullRequest.githubRepository;
			const { octokit, remote } = await githubRepository.ensure();

			if (!pullRequest.base) {
				const { data } = await octokit.pulls.get({
					owner: remote.owner,
					repo: remote.repositoryName,
					pull_number: pullRequest.prNumber
				});
				pullRequest.update(convertRESTPullRequestToRawPullRequest(data, githubRepository));
			}

			if (!pullRequest.mergeBase) {
				const { data } = await octokit.repos.compareCommits({
					repo: remote.repositoryName,
					owner: remote.owner,
					base: `${pullRequest.base.repositoryCloneUrl.owner}:${encodeURIComponent(pullRequest.base.ref)}`,
					head: `${pullRequest.head.repositoryCloneUrl.owner}:${encodeURIComponent(pullRequest.head.ref)}`
				});

				pullRequest.mergeBase = data.merge_base_commit.sha;
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching Pull Request merge base failed: ${formatError(e)}`);
		}
		Logger.debug(`Fullfill pull request missing info - done`, PullRequestManager.ID);
	}

	//#region Git related APIs

	async resolvePullRequest(owner: string, repositoryName: string, pullRequestNumber: number): Promise<PullRequestModel | undefined> {
		const githubRepo = this._githubRepositories.find(repo =>
			repo.remote.owner.toLowerCase() === owner.toLowerCase() && repo.remote.repositoryName.toLowerCase() === repositoryName.toLowerCase()
		);

		if (!githubRepo) {
			return;
		}

		const pr = await githubRepo.getPullRequest(pullRequestNumber);
		return pr;
	}

	async getMatchingPullRequestMetadataForBranch() {
		if (!this.repository || !this.repository.state.HEAD || !this.repository.state.HEAD.name) {
			return null;
		}

		const matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this.repository, this.repository.state.HEAD.name);
		return matchingPullRequestMetadata;
	}

	async checkoutExistingPullRequestBranch(pullRequest: PullRequestModel): Promise<boolean> {
		return await PullRequestGitHelper.checkoutExistingPullRequestBranch(this.repository, pullRequest);
	}

	async getBranchNameForPullRequest(pullRequest: PullRequestModel) {
		return await PullRequestGitHelper.getBranchNRemoteForPullRequest(this.repository, pullRequest);
	}

	async fetchAndCheckout(pullRequest: PullRequestModel): Promise<void> {
		await PullRequestGitHelper.fetchAndCheckout(this.repository, this._allGitHubRemotes, pullRequest);
	}

	async checkout(branchName: string): Promise<void> {
		return this.repository.checkout(branchName);
	}

	private handleError(e: any) {
		if (e.code && e.code === 422) {
			let errorObject: RestErrorResult;
			try {
				errorObject = e.message && JSON.parse(e.message);
			} catch {
				// If we failed to parse the JSON re-throw the original error
				// since it will have a more useful stack
				throw e;
			}
			const firstError = errorObject && errorObject.errors && errorObject.errors[0];
			if (firstError && firstError.code === 'missing_field' && firstError.field === 'body') {
				throw new Error('Body can\'t be blank');
			} else {
				throw new Error('There is already a pending review for this pull request on GitHub. Please finish or dismiss this review to be able to leave more comments');
			}

		} else {
			throw e;
		}
	}

	private async addReviewTimelineEventComments(pullRequest: PullRequestModel, events: TimelineEvent[]): Promise<void> {
		interface CommentNode extends IComment {
			childComments?: CommentNode[];
		}

		const reviewEvents = events.filter(isReviewEvent);
		const reviewComments = await this.getPullRequestComments(pullRequest) as CommentNode[];

		const reviewEventsById = reviewEvents.reduce((index, evt) => {
			index[evt.id] = evt;
			evt.comments = [];
			return index;
		}, {} as { [key: number]: CommonReviewEvent });

		const commentsById = reviewComments.reduce((index, evt) => {
			index[evt.id] = evt;
			return index;
		}, {} as { [key: number]: CommentNode });

		const roots: CommentNode[] = [];
		let i = reviewComments.length; while (i-- > 0) {
			const c: CommentNode = reviewComments[i];
			if (!c.inReplyToId) {
				roots.unshift(c);
				continue;
			}
			const parent = commentsById[c.inReplyToId];
			parent.childComments = parent.childComments || [];
			parent.childComments = [c, ...(c.childComments || []), ...parent.childComments];
		}

		roots.forEach(c => {
			const review = reviewEventsById[c.pullRequestReviewId!];
			if (review) {
				review.comments = review.comments.concat(c).concat(c.childComments || []);
			}
		});

		const pendingReview = reviewEvents.filter(r => r.state.toLowerCase() === 'pending')[0];
		if (pendingReview) {
			// Ensures that pending comments made in reply to other reviews are included for the pending review
			pendingReview.comments = reviewComments.filter(c => c.isDraft);
		}
	}

	private async fixCommitAttribution(pullRequest: PullRequestModel, events: TimelineEvent[]): Promise<void> {
		const commits = await this.getPullRequestCommits(pullRequest);
		const commitEvents = events.filter(isCommitEvent);
		for (const commitEvent of commitEvents) {
			const matchingCommits = commits.filter(commit => commit.sha === commitEvent.sha);
			if (matchingCommits.length === 1) {
				const author = matchingCommits[0].author;
				// There is not necessarily a GitHub account associated with the commit.
				if (author !== null) {
					if (pullRequest.githubRepository.isGitHubDotCom) {
						commitEvent.author.avatarUrl = author.avatar_url;
					}

					commitEvent.author.login = author.login;
					commitEvent.author.url = author.html_url;
				}
			}
		}
	}

	private async parseRESTTimelineEvents(pullRequest: PullRequestModel, remote: Remote, events: any[]): Promise<TimelineEvent[]> {
		events.forEach(event => {
			const type = getEventType(event.event);
			event.event = type;
			return event;
		});

		events.forEach(event => {
			if (event.event === EventType.Commented) {
				this.addCommentPermissions(event, remote);
			}
		});

		await Promise.all([
			this.addReviewTimelineEventComments(pullRequest, events),
			this.fixCommitAttribution(pullRequest, events)
		]);

		return events;
	}

	createGitHubRepository(remote: Remote, credentialStore: CredentialStore): GitHubRepository {
		return new GitHubRepository(remote, credentialStore);
	}

	dispose() {
		this._subs.forEach(sub => sub.dispose());
	}
}

export function getEventType(text: string) {
	switch (text) {
		case 'committed':
			return EventType.Committed;
		case 'mentioned':
			return EventType.Mentioned;
		case 'subscribed':
			return EventType.Subscribed;
		case 'commented':
			return EventType.Commented;
		case 'reviewed':
			return EventType.Reviewed;
		default:
			return EventType.Other;
	}
}

const ownedByMe: Predicate<GitHubRepository> = repo => {
	const { currentUser = null } = repo.octokit as any;
	return currentUser && repo.remote.owner === currentUser.login;
};

const byRemoteName = (name: string): Predicate<GitHubRepository> =>
	({ remote: { remoteName } }) => remoteName === name;

export const titleAndBodyFrom = (message: string): { title: string, body: string } => {
	const idxLineBreak = message.indexOf('\n');
	return {
		title: idxLineBreak === -1
			? message
			: message.substr(0, idxLineBreak),

		body: idxLineBreak === -1
			? ''
			: message.slice(idxLineBreak + 1),
	};
};

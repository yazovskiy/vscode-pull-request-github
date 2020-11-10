/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import TelemetryReporter from 'vscode-extension-telemetry';
import { Repository } from './api/api';
import { GitApiImpl } from './api/api1';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { Resource } from './common/resources';
import { handler as uriHandler } from './common/uri';
import { onceEvent } from './common/utils';
import * as PersistentState from './common/persistentState';
import { EXTENSION_ID } from './constants';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
import { registerBuiltinGitProvider } from './gitProviders/api';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager } from './view/reviewManager';
import { IssueFeatureRegistrar } from './issues/issueFeatureRegistrar';
import { CredentialStore } from './github/credentials';
import { GitHubContactServiceProvider } from './gitProviders/GitHubContactServiceProvider';
import { LiveShare } from 'vsls/vscode.js';
import { RepositoriesManager } from './github/repositoriesManager';
import { PullRequestChangesTreeDataProvider } from './view/prChangesTreeDataProvider';
import { ReviewsManager } from './view/reviewsManager';
import { registerLiveShareGitProvider } from './gitProviders/api';

const aiKey: string = 'AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217';

// fetch.promise polyfill
const fetch = require('node-fetch');
const PolyfillPromise = require('es6-promise').Promise;
fetch.Promise = PolyfillPromise;

let telemetry: TelemetryReporter;

async function init(context: vscode.ExtensionContext, git: GitApiImpl, credentialStore: CredentialStore, repositories: Repository[], tree: PullRequestsTreeDataProvider, liveshareApiPromise: Promise<LiveShare | undefined>): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	vscode.authentication.onDidChangeSessions(async e => {
		if (e.provider.id === 'github') {
			await reposManager.clearCredentialCache();
			if (reviewManagers) {
				reviewManagers.forEach(reviewManager => reviewManager.updateState());
			}
		}
	});

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(new FileTypeDecorationProvider());
	// Sort the repositories to match folders in a multiroot workspace (if possible).
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		repositories = repositories.sort((a, b) => {
			let indexA = workspaceFolders.length;
			let indexB = workspaceFolders.length;
			for (let i = 0; i < workspaceFolders.length; i++) {
				if (workspaceFolders[i].uri.toString() === a.rootUri.toString()) {
					indexA = i;
				} else if (workspaceFolders[i].uri.toString() === b.rootUri.toString()) {
					indexB = i;
				}
				if (indexA !== workspaceFolders.length && indexB !== workspaceFolders.length) {
					break;
				}
			}
			return indexA - indexB;
		});
	}
	const folderManagers = repositories.map(repository => new FolderRepositoryManager(repository, telemetry, git, credentialStore));
	context.subscriptions.push(...folderManagers);
	const reposManager = new RepositoriesManager(folderManagers, credentialStore, telemetry);
	context.subscriptions.push(reposManager);

	liveshareApiPromise.then((api) => {
		if (api) {
			// register the pull request provider to suggest PR contacts
			api.registerContactServiceProvider('github-pr', new GitHubContactServiceProvider(reposManager));
		}
	});
	const changesTree = new PullRequestChangesTreeDataProvider(context);
	context.subscriptions.push(changesTree);
	const reviewManagers = folderManagers.map(folderManager => new ReviewManager(context, folderManager.repository, folderManager, telemetry, changesTree));
	const reviewsManager = new ReviewsManager(context, reposManager, reviewManagers, tree, changesTree, telemetry, git);
	context.subscriptions.push(reviewsManager);
	tree.initialize(reposManager);
	registerCommands(context, reposManager, reviewManagers, telemetry, credentialStore, tree);

	git.onDidChangeState(() => {
		reviewManagers.forEach(reviewManager => reviewManager.updateState());
	});

	git.onDidOpenRepository(repo => {
		const disposable = repo.state.onDidChange(() => {
			const newFolderManager = new FolderRepositoryManager(repo, telemetry, git, credentialStore);
			reposManager.insertFolderManager(newFolderManager);
			const newReviewManager = new ReviewManager(context, newFolderManager.repository, newFolderManager, telemetry, changesTree);
			reviewManagers.push(newReviewManager);
			tree.refresh();
			disposable.dispose();
		});
	});

	await vscode.commands.executeCommand('setContext', 'github:initialized', true);
	const issuesFeatures = new IssueFeatureRegistrar(git, reposManager, reviewManagers, context, telemetry);
	context.subscriptions.push(issuesFeatures);
	await issuesFeatures.initialize();

	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

export async function activate(context: vscode.ExtensionContext): Promise<GitApiImpl> {
	// initialize resources
	Resource.initialize(context);
	const apiImpl = new GitApiImpl();

	const version = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.version;
	telemetry = new TelemetryReporter(EXTENSION_ID, version, aiKey);
	context.subscriptions.push(telemetry);

	PersistentState.init(context);
	const credentialStore = new CredentialStore(telemetry);
	context.subscriptions.push(credentialStore);
	await credentialStore.initialize();

	const builtInGitProvider = registerBuiltinGitProvider(credentialStore, apiImpl);
	if (builtInGitProvider) {
		context.subscriptions.push(builtInGitProvider);
	}
	const liveshareGitProvider = registerLiveShareGitProvider(apiImpl);
	context.subscriptions.push(liveshareGitProvider);
	const liveshareApiPromise = liveshareGitProvider.initialize();

	context.subscriptions.push(apiImpl);

	Logger.appendLine('Looking for git repository');

	const prTree = new PullRequestsTreeDataProvider(telemetry);
	context.subscriptions.push(prTree);

	if (apiImpl.repositories.length > 0) {
		await init(context, apiImpl, credentialStore, apiImpl.repositories, prTree, liveshareApiPromise);
	} else {
		onceEvent(apiImpl.onDidOpenRepository)(r => init(context, apiImpl, credentialStore, [r], prTree, liveshareApiPromise));
	}

	return apiImpl;
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}
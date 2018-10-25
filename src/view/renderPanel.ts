/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce } from '../common/utils';
import { Store } from '../store';

interface RenderPanelConstructor {
	new(key: string, viewType: string, column: vscode.ViewColumn): RenderPanel;
}

export abstract class RenderPanel {
	private static _extensionPath: string | undefined;
	private static _instances: Map<string, RenderPanel> = new Map;

	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	public static init(extensionPath: string) {
		this._extensionPath = extensionPath;
	}

	public abstract entryPoint: string;

	public static get viewType() {
		return this.name;
	}

	public get title() {
		return this.key;
	}

	public static get [Symbol.species](): RenderPanelConstructor { return <RenderPanelConstructor>(this as any); }

	public static show(key: string, column = vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn) {
		const existing = this._instances.get(key);
		if (existing) {
			existing._panel.reveal(column, true);
			return existing;
		}
		const created = new this[Symbol.species](key, this.viewType, column);
		this._instances.set(key, created);
		return created;
	}

	protected getMediaUri(...components: string[]): vscode.Uri {
		return vscode.Uri.file(path.join(RenderPanel._extensionPath, 'media', ...components));
	}

	protected constructor(public readonly key: string, viewType: string, column: vscode.ViewColumn) {
		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(
			viewType, this.title, column, {
				// Enable javascript in the webview
				enableScripts: true,

				// And restric the webview to only loading content from our extension's `media` directory.
				localResourceRoots: [this.getMediaUri()],
			}
		);
		this._panel.webview.html = this.html;

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Dispatch store state to the webview
		Store.onState(this._sendState, this._disposables);

		// Handle messages from the webview as actions
		this._panel.webview.onDidReceiveMessage(Store.dispatch, Store, this._disposables);
	}

	public dispose() {
		RenderPanel._instances.delete(this.key);

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	_sendState = state => this._panel.webview.postMessage(state);

	get scriptUri() {
		return this.getMediaUri(this.entryPoint).with({ scheme: 'vscode-resource' });
	}

	private get nonce() {
		const value = getNonce();
		Object.defineProperty(this, 'nonce', {value});
		return value;
	}

	private get html() {
		const {nonce, scriptUri} = this;
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>${this.title}</title>
			</head>
			<body>
				<script data-key="${this.key}" nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

export class PrPreviewPanel extends RenderPanel {
	get entryPoint() { return 'preview.js'; }

	get title() {
		return `PR Preview (${this.key})`;
	}
}

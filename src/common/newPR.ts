import { stat as statCb, writeFile as writeFileCb } from 'fs';
import { promisify } from 'util';
import { IPullRequestManager } from '../github/interface';
import { join } from 'path';
const writeFile = promisify(writeFileCb);
const stat = promisify(statCb);

const exists = file => stat(file).catch(() => null);
const mdPath = uri => join(uri.fsPath, '.git', 'PULL_REQUEST.md');

export const findOrCreatePRMarkdown = async (manager: IPullRequestManager): Promise<string> => {
	const root = manager.repository.rootUri;
	const path = mdPath(root);
	if (!await exists(path)) {
		const {title, body, head, base} = await manager.getPullRequestDefaults();
		const branch = manager.repository.state.HEAD.name;
		const remote = manager.repository.state.HEAD.remote || manager.findRepo(() => true).remote.remoteName;
		await writeFile(path, `---\ntitle: ${title}\nbranch: ${branch}\nremote: ${remote}\nhead: ${head}\nbase: ${base}\n---\n${body}\n`);
	}
	return path;
};
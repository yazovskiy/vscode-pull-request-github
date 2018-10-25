import { h, render, Component } from 'preact';
import markdown from './mdRenderer';
import { State, DraftPR, GitHubRemotesState } from '~/shared/state';

import './index.css';

declare var acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

const main = document.createElement('div');
document.body.appendChild(main);

const uri = document.currentScript!.dataset.key!;

const Markdown = ({ src }: { src: string }) =>
	<div dangerouslySetInnerHTML={{ __html: markdown.render(src) }} />;

type PreviewState = {
	gitHubRemotes?: GitHubRemotesState;
	draft?: DraftPR;
};

class Preview extends Component<{ uri: string }, PreviewState> {
	state: PreviewState = {};
	componentDidMount() { addEventListener('message', this.recvState); }
	componentWillUnmount() { removeEventListener('message', this.recvState); }

	recvState = (event: MessageEvent) =>
		this.setState({
			gitHubRemotes: event.data.gitHubRemotes,
			draft: event.data.draftPRs[this.props.uri]
		})

	render() {
		if (!this.state.draft) { return <h2>Loading...</h2>; }
		const { draft } = this.state;
		return <div>
			<h1>{draft.title}</h1>
			<Markdown src={draft.__content} />
			<div class='pr-preview-pipeline'>{draft.branch} {above('➡️', 'PUSH')} {draft.head} {above('➡️', 'PR')} {draft.base}</div>
			<div class='form-actions'>
				<input
					type='submit' value='Create PR' />
			</div>
		</div>;
	}
}

const above = (a: string, b: string) => <span class='above' style={{
	display: 'inline-flex',
	flexDirection: 'column',
	textAlign: 'center',
	alignItems: 'center',
	verticalAlign: 'middle',
}}>
	<div>{a}</div>
	<div>{b}</div>
</span>;

render(<Preview uri={uri} />, main);
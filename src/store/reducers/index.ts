import { State } from '~/shared/state';
import { combineReducers } from '../handler';

import localBranches from './localBranches';
import newPR from './newPR';
import gitHubRemotes from './gitHubRemotes';
import draftPRs from './draftPRs';

export default combineReducers<State>({
	localBranches,
	gitHubRemotes,
	newPR,
	draftPRs,
	hi: (state, action) => 'hi',
});

import { DraftPR } from '~/shared/state';
import { SET_PR_MARKDOWN } from '~/shared/actions';

import { safeLoadFront } from 'yaml-front-matter';

export default (state: { [uri: string]: DraftPR } = {}, {type, uri, src}) => {
	if (type !== SET_PR_MARKDOWN) { return state; }
	const data = safeLoadFront(src);
	return { ...state, [uri]: data, };
};
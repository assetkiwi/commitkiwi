import { getContext, setContext } from "svelte";

/** What a component inside a repo tab knows about that tab: every open tab stays mounted (hidden when not
 *  shown), so commands register only while `active()`, and keymap modes go to the tab's own `modes`. */
export interface TabScope { active: () => boolean; modes: Record<string, boolean> }
const KEY = Symbol("tabScope");
export const provideTabScope = (s: TabScope) => setContext(KEY, s);
/** Outside a repo tab (tests, the merge tool opened alone): always active, modes nobody reads. */
export const tabScope = (): TabScope => getContext<TabScope>(KEY) ?? { active: () => true, modes: {} };

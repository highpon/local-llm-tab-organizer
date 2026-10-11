export const NO_GROUP = -1;
export type Mode = 'auto' | 'suggest' | 'off';
export interface TabInfo {
  id: number; windowId: number; url: string; title: string;
  pinned: boolean; active: boolean; audible: boolean;
  lastAccessed: number; groupId: number; // NO_GROUP = 未所属
}
export interface GroupInfo { id: number; windowId: number; title: string }
export interface Snapshot { tabs: TabInfo[]; groups: GroupInfo[]; groupsSupported: boolean }
export interface CloseEntry { tabId: number; keepTabId: number; windowId: number; url: string }
export interface DedupePlan { closes: CloseEntry[] }
export interface Assignment { tabId: number; group: string }
export interface GroupAdd { tabId: number; windowId: number; url: string }
export interface GroupingPlan {
  addToExisting: { groupId: number; tabs: GroupAdd[] }[];
  createNew: { windowId: number; title: string; tabs: GroupAdd[] }[];
}
export type ClassifyMethod = 'llm' | 'domain' | 'mixed';
export type LlmErrorKind = 'unreachable' | 'timeout' | 'forbidden' | 'http' | 'badResponse';

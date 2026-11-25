declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  /** The GFM bundle: tables, strikethrough, task-list items and highlighted code blocks. */
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}

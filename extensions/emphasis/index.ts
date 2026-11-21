// Draws icons on report labels and links in assistant replies.
// Adapted from github.com/johnlindquist/pi-emphasis, MIT, Copyright (c) 2026 John Lindquist.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { chartTables } from "./chart.ts";

// The labels of a final report, named in the Communication section of prompts/AGENTS.md.
const LABELS: Record<string, string> = {
  finding: "\uf002", plan: "\uf0ae", result: "\uf11e", changed: "\uf040", checked: "\uf00c", remains: "\uf141",
  "needs you": "\uf007", risk: "\uf071", next: "\uf061", cause: "\uf0e7", fix: "\uf0ad",
};
const URL_ICON = "\uf08e";
const FILE_ICON = "\uf15b";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^( {0,3}#{1,6}\s+)(.+)$/;
const LEAD = /^(\s*(?:[-*+]|\d+\.)?\s*(?:[├└]──\s*)?\*\*)([^*`\n]{1,32})(\*\*)/;
const LINK = /(?<!!)\[([^\]\n]+)\]\(([^)\s#][^)\s]*)\)/g;

const withIcon = (label: string) => {
  const icon = LABELS[label.replace(/[:\s]+$/, "").toLowerCase()];
  return icon ? `${icon} ${label}` : label;
};

/** Adds the icons and colors to the prose of `markdown`; code spans and fenced blocks stay as written. */
export function decorate(markdown: string, theme: Pick<Theme, "fg">): string {
  const prose = (text: string) =>
    text
      .replace(LINK, (_, label: string, target: string) => `[${/^[a-z][a-z\d+.-]*:/i.test(target) ? URL_ICON : FILE_ICON} ${label}](${target})`)
      .replace(/[✓✔]/g, (mark) => theme.fg("success", mark))
      .replace(/[✗✘]/g, (mark) => theme.fg("error", mark))
      .replace(/→/g, (mark) => theme.fg("accent", mark))
      .replace(/[├└]──/g, (mark) => theme.fg("dim", mark));
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(FENCE)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      if (HEADING.test(line)) return line.replace(HEADING, (_, hashes: string, title: string) => hashes + withIcon(title));
      return line
        .replace(LEAD, (_, before: string, label: string, after: string) => before + withIcon(label) + after)
        .split(/(`+[^`]*?`+)/g)
        .map((part, i) => (i % 2 ? part : prose(part)))
        .join("");
    })
    .join("\n");
}

export default function emphasis(pi: ExtensionAPI) {
  let theme: Theme | undefined;
  pi.on("session_start", (_event, ctx) => {
    theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
  });
  // An extension has one transformer. The chart reads the table before the icons and colors are added.
  pi.registerMarkdownTransformer((markdown) => (theme ? decorate(chartTables(markdown), theme) : markdown), { messageTypes: ["assistant"] });
}

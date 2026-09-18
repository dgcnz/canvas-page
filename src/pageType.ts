import type {
  QuartzPageTypePlugin,
  PageMatcher,
  FullSlug,
  VirtualPage,
} from "@quartz-community/types";
import type { BuildCtx, FilePath, PluginTypes, SimpleSlug } from "@quartz-community/types";
import { slugifyFilePath } from "@quartz-community/utils/path";
import { readFileSync } from "fs";
import { join } from "path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkBreaks from "remark-breaks";
import { toHtml } from "hast-util-to-html";
import { VFile } from "vfile";
import type { Root as HastRoot } from "hast";
import CanvasBody from "./components/CanvasBody";
import type { CanvasData, CanvasPageOptions } from "./types";

/**
 * Builds the same markdown -> HTML pipeline Quartz runs on notes (see
 * quartz/processors/parse.ts), so text nodes get wikilinks, math, callouts,
 * highlights etc. exactly as configured for the site, instead of bare GFM.
 */
function createTextRenderer(ctx: BuildCtx) {
  // QuartzConfig types `plugins` as unknown; at runtime it is the loaded PluginTypes.
  const transformers = (ctx.cfg.plugins as PluginTypes).transformers;
  const processor = unified()
    .use(remarkParse)
    // Obsidian renders a single newline in a card as a line break (strict line breaks off)
    .use(remarkBreaks)
    .use(transformers.flatMap((p) => p.markdownPlugins?.(ctx) ?? []))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(transformers.flatMap((p) => p.htmlPlugins?.(ctx) ?? []));

  return async (text: string, canvasPath: FilePath, canvasSlug: FullSlug) => {
    let value = text.trim();
    for (const p of transformers) {
      if (p.textTransform) value = p.textTransform(ctx, value);
    }
    // Each card is processed as if it were a note living at the canvas's path,
    // so relative links resolve against the canvas page.
    const file = new VFile({ value, path: join(ctx.argv.directory, canvasPath) });
    file.data.filePath = file.path as FilePath;
    file.data.relativePath = canvasPath;
    file.data.slug = canvasSlug;
    file.data.frontmatter = { title: "", tags: [] };
    const tree = (await processor.run(processor.parse(file), file)) as HastRoot;
    const links = (file.data.links as SimpleSlug[] | undefined) ?? [];
    return { html: toHtml(tree, { allowDangerousHtml: true }), links };
  };
}

async function preprocessCanvasData(
  data: CanvasData,
  render: (text: string) => Promise<{ html: string; links: SimpleSlug[] }>,
): Promise<CanvasData & { renderedTexts: Record<string, string>; links: SimpleSlug[] }> {
  const renderedTexts: Record<string, string> = {};
  const links = new Set<SimpleSlug>();

  for (const node of data.nodes ?? []) {
    if (node.type === "text" && node.text) {
      const out = await render(node.text);
      renderedTexts[node.id] = out.html;
      out.links.forEach((l) => links.add(l));
    }
  }

  return { ...data, renderedTexts, links: [...links] };
}

const canvasMatcher: PageMatcher = ({ fileData }) => {
  return "canvasData" in fileData;
};

export const CanvasPage: QuartzPageTypePlugin<CanvasPageOptions> = (opts) => ({
  name: "CanvasPage",
  priority: 20,
  fileExtensions: [".canvas"],
  match: canvasMatcher,
  // Async: needs Quartz core to `await pt.generate(...)` (upstream calls it synchronously).
  // @ts-expect-error PageGenerator in @quartz-community/types is still typed as sync
  async generate({ ctx }) {
    const canvasFiles = ctx.allFiles.filter((fp) => fp.endsWith(".canvas"));
    if (canvasFiles.length === 0) return [];

    const renderText = createTextRenderer(ctx);
    const virtualPages: VirtualPage[] = [];

    for (const filePath of canvasFiles) {
      const fullPath = join(ctx.argv.directory, filePath);
      let canvasData: CanvasData;

      try {
        const raw = readFileSync(fullPath, "utf-8");
        canvasData = JSON.parse(raw) as CanvasData;
      } catch {
        continue;
      }

      const baseName =
        filePath
          .replace(/\.canvas$/, "")
          .split("/")
          .pop() ?? "Canvas";
      const slug = slugifyFilePath(filePath) as FullSlug;
      const processedData = await preprocessCanvasData(canvasData, (text) =>
        renderText(text, filePath, slug),
      );

      virtualPages.push({
        slug,
        title: baseName,
        data: {
          frontmatter: { title: baseName, tags: [] },
          // outgoing links from text cards, so the canvas shows up in the graph and backlinks
          links: processedData.links,
          canvasData: processedData,
          canvasOptions: opts,
        },
      });
    }

    return virtualPages;
  },
  layout: "canvas",
  frame: "canvas",
  body: CanvasBody,
});

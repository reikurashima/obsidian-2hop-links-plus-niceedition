import { App, CachedMetadata, TFile } from "obsidian";
import { FileEntity } from "./model/FileEntity";
import {
  filePathToLinkText,
  removeBlockReference,
  shouldExcludePath,
} from "./utils";
import {
  getSortFunction,
  getSortFunctionForFile,
  getSortedFiles,
  getTagHierarchySortFunction,
} from "./sort";
import { PropertiesLinks } from "./model/PropertiesLinks";

export class Links {
  app: App;
  settings: any;

  constructor(app: App, settings: any) {
    this.app = app;
    this.settings = settings;
  }

  async gatherTwoHopLinks(activeFile: TFile | null): Promise<{
    newLinks: FileEntity[];
    backwardLinks: FileEntity[];
    tagLinksList: PropertiesLinks[];
    frontmatterKeyLinksList: PropertiesLinks[];
  }> {
    let newLinks: FileEntity[] = [];
    let backwardLinks: FileEntity[] = [];
    let tagLinksList: PropertiesLinks[] = [];
    let frontmatterKeyLinksList: PropertiesLinks[] = [];

    if (activeFile) {
      const activeFileCache: CachedMetadata =
        this.app.metadataCache.getFileCache(activeFile);

      // Gather new (unresolved) links
      newLinks = await this.getNewLinks(activeFile, activeFileCache);

      // Gather back links
      const seenLinkSet = new Set<string>();
      backwardLinks = await this.getBackLinks(activeFile, seenLinkSet);
      backwardLinks.forEach((link) => seenLinkSet.add(link.key()));

      const globalSeenSet = new Set<string>();

      // Gather link-based groups (like Scrapbox: files sharing the same [[link]])
      const linkBasedList = await this.getLinksListOfFilesWithLinks(
        activeFile,
        activeFileCache,
        seenLinkSet,
        globalSeenSet
      );

      // Gather tag-based groups
      const tagBasedList = await this.getLinksListOfFilesWithTags(
        activeFile,
        activeFileCache,
        seenLinkSet,
        globalSeenSet
      );

      // Merge link-based and tag-based groups into one unified list
      tagLinksList = [...linkBasedList, ...tagBasedList];

      frontmatterKeyLinksList =
        await this.getLinksListOfFilesWithFrontmatterKeys(
          activeFile,
          activeFileCache,
          seenLinkSet,
          globalSeenSet
        );
    } else {
      const allMarkdownFiles = this.app.vault
        .getMarkdownFiles()
        .filter(
          (file: { path: string }) =>
            !shouldExcludePath(file.path, this.settings.excludePaths)
        );

      const sortedFiles = await getSortedFiles(
        allMarkdownFiles,
        getSortFunctionForFile(this.settings.sortOrder)
      );

      // Show all files as tag links when no active file
      tagLinksList = [];
    }

    return {
      newLinks,
      backwardLinks,
      tagLinksList,
      frontmatterKeyLinksList,
    };
  }

  async getNewLinks(
    activeFile: TFile,
    activeFileCache: CachedMetadata
  ): Promise<FileEntity[]> {
    const newLinks: FileEntity[] = [];

    if (
      activeFileCache != null &&
      (activeFileCache.links != null ||
        activeFileCache.embeds != null ||
        (activeFileCache as any).frontmatterLinks != null)
    ) {
      const seen = new Set<string>();
      const linkEntities = [
        ...(activeFileCache.links || []),
        ...(activeFileCache.embeds || []),
        ...((activeFileCache as any).frontmatterLinks || []),
      ];

      for (const it of linkEntities) {
        const key = removeBlockReference(it.link);
        if (!seen.has(key)) {
          seen.add(key);
          const targetFile = this.app.metadataCache.getFirstLinkpathDest(
            key,
            activeFile.path
          );

          if (
            targetFile &&
            shouldExcludePath(targetFile.path, this.settings.excludePaths)
          ) {
            continue;
          }

          if (!targetFile) {
            const backlinksCount = await this.getBacklinksCount(
              key,
              activeFile.path
            );
            if (
              1 <= backlinksCount &&
              this.settings.createFilesForMultiLinked
            ) {
              await this.app.vault.create(
                `${this.app.workspace.getActiveFile().parent.path}/${key}.md`,
                ""
              );
            } else {
              newLinks.push(new FileEntity(activeFile.path, key));
            }
          }
        }
      }
    } else if (activeFile.extension === "canvas") {
      const canvasContent = await this.app.vault.read(activeFile);
      let canvasData;
      try {
        canvasData = JSON.parse(canvasContent);
        if (canvasData.nodes) {
          if (!Array.isArray(canvasData.nodes)) {
            console.error("Invalid structure in canvas: nodes is not an array");
            canvasData = { nodes: [] };
          }
        }
      } catch (error) {
        console.error("Invalid JSON in canvas:", error);
        canvasData = { nodes: [] };
      }

      const seen = new Set<string>();
      if (canvasData.nodes) {
        for (const node of canvasData.nodes) {
          if (node.type === "file") {
            const key = node.file;
            if (!seen.has(key)) {
              seen.add(key);
              const targetFile = this.app.vault.getAbstractFileByPath(key);
              if (
                !targetFile ||
                shouldExcludePath(targetFile.path, this.settings.excludePaths)
              ) {
                newLinks.push(new FileEntity(activeFile.path, key));
              }
            }
          }
        }
      }
    }

    // Also add tags whose corresponding page doesn't exist yet
    if (activeFileCache) {
      const seen = newLinks.reduce((s, e) => { s.add(e.linkText); return s; }, new Set<string>());
      const activeFileTags = this.getTagsFromCache(
        activeFileCache,
        this.settings.excludeTags
      );
      for (const tag of activeFileTags) {
        if (seen.has(tag)) continue;
        seen.add(tag);
        const tagFile = this.app.metadataCache.getFirstLinkpathDest(
          tag,
          activeFile.path
        );
        if (!tagFile) {
          newLinks.push(new FileEntity(activeFile.path, tag));
        }
      }
    }

    return newLinks;
  }

  /**
   * Scrapbox-style link grouping: for each [[link]] in the active file,
   * find all other files that also contain [[link]], and group them.
   */
  async getLinksListOfFilesWithLinks(
    activeFile: TFile,
    activeFileCache: CachedMetadata,
    backLinkSet: Set<string>,
    globalSeenSet: Set<string>
  ): Promise<PropertiesLinks[]> {
    // Get all resolved link targets from the active file
    const activeFileLinks: Set<string> = new Set();

    if (activeFileCache != null) {
      const linkEntities = [
        ...(activeFileCache.links || []),
        ...(activeFileCache.embeds || []),
        ...((activeFileCache as any).frontmatterLinks || []),
      ];

      for (const it of linkEntities) {
        const key = removeBlockReference(it.link);
        const targetFile = this.app.metadataCache.getFirstLinkpathDest(
          key,
          activeFile.path
        );
        if (targetFile && !shouldExcludePath(targetFile.path, this.settings.excludePaths)) {
          activeFileLinks.add(targetFile.path);
        }
      }
    }

    if (activeFile.extension === "canvas") {
      const canvasContent = await this.app.vault.read(activeFile);
      let canvasData;
      try {
        canvasData = JSON.parse(canvasContent);
      } catch (error) {
        canvasData = { nodes: [] };
      }
      if (Array.isArray(canvasData?.nodes)) {
        for (const node of canvasData.nodes) {
          if (node.type === "file") {
            const targetFile = this.app.vault.getAbstractFileByPath(node.file);
            if (targetFile && !shouldExcludePath(targetFile.path, this.settings.excludePaths)) {
              activeFileLinks.add(targetFile.path);
            }
          }
        }
      }
    }

    if (activeFileLinks.size === 0) return [];

    // For each link target, find all other files that also link to it
    const linkMap: Record<string, FileEntity[]> = {};
    const resolvedLinks: Record<string, Record<string, number>> =
      this.app.metadataCache.resolvedLinks;

    for (const src of Object.keys(resolvedLinks)) {
      if (src === activeFile.path) continue;
      if (shouldExcludePath(src, this.settings.excludePaths)) continue;

      for (const dest of Object.keys(resolvedLinks[src])) {
        if (activeFileLinks.has(dest)) {
          const linkText = filePathToLinkText(src);

          if (
            this.settings.enableDuplicateRemoval &&
            (backLinkSet.has(linkText) || globalSeenSet.has(linkText))
          ) {
            continue;
          }

          const displayName = filePathToLinkText(dest);
          linkMap[displayName] = linkMap[displayName] ?? [];

          const newFileEntity = new FileEntity(activeFile.path, linkText);
          if (
            !linkMap[displayName].some(
              (e) =>
                e.sourcePath === newFileEntity.sourcePath &&
                e.linkText === newFileEntity.linkText
            )
          ) {
            linkMap[displayName].push(newFileEntity);
            globalSeenSet.add(linkText);
          }
        }
      }
    }

    const linkLinksEntities = await this.createPropertiesLinkEntities(
      this.settings,
      linkMap,
      "links"
    );

    const sortFunction = getTagHierarchySortFunction(this.settings.sortOrder);
    return linkLinksEntities.sort(sortFunction);
  }

  async getBacklinksCount(file: string, excludeFile?: string): Promise<number> {
    const unresolvedLinks: Record<string, Record<string, number>> = this.app
      .metadataCache.unresolvedLinks;
    let backlinkCount = 0;

    for (const src of Object.keys(unresolvedLinks)) {
      if (excludeFile && src === excludeFile) {
        continue;
      }
      for (let dest of Object.keys(unresolvedLinks[src])) {
        dest = removeBlockReference(dest);
        if (dest === file) {
          backlinkCount++;
        }
      }
    }
    return backlinkCount;
  }

  async getBackLinks(
    activeFile: TFile,
    forwardLinkSet: Set<string>
  ): Promise<FileEntity[]> {
    const name = activeFile.path;
    const resolvedLinks: Record<string, Record<string, number>> = this.app
      .metadataCache.resolvedLinks;
    const backLinkEntities: FileEntity[] = [];
    const seenSources = new Set<string>();

    // 1. Standard backlinks: files that have [[activeFile]] link
    for (const src of Object.keys(resolvedLinks)) {
      if (shouldExcludePath(src, this.settings.excludePaths)) {
        continue;
      }
      for (const dest of Object.keys(resolvedLinks[src])) {
        if (dest == name) {
          const linkText = filePathToLinkText(src);
          if (
            this.settings.enableDuplicateRemoval &&
            forwardLinkSet.has(linkText)
          ) {
            continue;
          }
          if (!seenSources.has(src)) {
            seenSources.add(src);
            backLinkEntities.push(new FileEntity(src, linkText));
          }
        }
      }
    }

    // 2. Tag-based backlinks: files that have #activeFileName tag
    //    e.g. if activeFile is "〇〇.md", files with #〇〇 tag are backlinks
    const activeFileName = filePathToLinkText(activeFile.path);
    const markdownFiles = this.app.vault.getMarkdownFiles();

    for (const mdFile of markdownFiles) {
      if (mdFile.path === activeFile.path) continue;
      if (shouldExcludePath(mdFile.path, this.settings.excludePaths)) continue;
      if (seenSources.has(mdFile.path)) continue;

      const cache = this.app.metadataCache.getFileCache(mdFile);
      if (!cache) continue;

      const fileTags = this.getTagsFromCache(cache, this.settings.excludeTags);
      // Check if any tag matches the active file name
      if (fileTags.some((tag) => tag === activeFileName)) {
        const linkText = filePathToLinkText(mdFile.path);
        if (
          this.settings.enableDuplicateRemoval &&
          forwardLinkSet.has(linkText)
        ) {
          continue;
        }
        seenSources.add(mdFile.path);
        backLinkEntities.push(new FileEntity(mdFile.path, linkText));
      }
    }

    // 3. Forward links: pages that this file links to via [[link]]
    const activeFileCache = this.app.metadataCache.getFileCache(activeFile);
    if (activeFileCache) {
      const linkEntities = [
        ...(activeFileCache.links || []),
        ...(activeFileCache.embeds || []),
        ...((activeFileCache as any).frontmatterLinks || []),
      ];
      for (const it of linkEntities) {
        const key = removeBlockReference(it.link);
        const targetFile = this.app.metadataCache.getFirstLinkpathDest(
          key,
          activeFile.path
        );
        if (
          targetFile &&
          targetFile.path !== activeFile.path &&
          !seenSources.has(targetFile.path) &&
          !shouldExcludePath(targetFile.path, this.settings.excludePaths)
        ) {
          seenSources.add(targetFile.path);
          const linkText = filePathToLinkText(targetFile.path);
          backLinkEntities.push(new FileEntity(targetFile.path, linkText));
        }
      }
    }

    // 4. Tag page links: if active file has #AA tag, add "AA" page to backlinks
    if (activeFileCache) {
      const activeFileTags = this.getTagsFromCache(
        activeFileCache,
        this.settings.excludeTags
      );
      for (const tag of activeFileTags) {
        // Find a file matching the tag name
        const tagFile = this.app.metadataCache.getFirstLinkpathDest(
          tag,
          activeFile.path
        );
        if (
          tagFile &&
          tagFile.path !== activeFile.path &&
          !seenSources.has(tagFile.path) &&
          !shouldExcludePath(tagFile.path, this.settings.excludePaths)
        ) {
          const linkText = filePathToLinkText(tagFile.path);
          if (
            this.settings.enableDuplicateRemoval &&
            forwardLinkSet.has(linkText)
          ) {
            continue;
          }
          seenSources.add(tagFile.path);
          backLinkEntities.push(new FileEntity(tagFile.path, linkText));
        }
      }
    }

    // 5. Canvas backlinks
    const allFiles: TFile[] = this.app.vault.getFiles();
    const canvasFiles: TFile[] = allFiles.filter(
      (file) => file.extension === "canvas"
    );

    for (const canvasFile of canvasFiles) {
      const canvasContent = await this.app.vault.read(canvasFile);
      let canvasData;
      try {
        canvasData = JSON.parse(canvasContent);
        if (canvasData.nodes) {
          if (!Array.isArray(canvasData.nodes)) {
            console.error("Invalid structure in canvas: nodes is not an array");
            canvasData = { nodes: [] };
          }
        }
      } catch (error) {
        console.error("Invalid JSON in canvas:", error);
        canvasData = { nodes: [] };
      }

      if (canvasData.nodes) {
        for (const node of canvasData.nodes) {
          if (node.type === "file" && node.file === activeFile.path) {
            const linkText = filePathToLinkText(canvasFile.path);
            if (!forwardLinkSet.has(linkText) && !seenSources.has(canvasFile.path)) {
              seenSources.add(canvasFile.path);
              backLinkEntities.push(new FileEntity(canvasFile.path, linkText));
            }
          }
        }
      }
    }

    return await this.getSortedFileEntities(
      backLinkEntities,
      (entity) => entity.sourcePath,
      this.settings.sortOrder
    );
  }

  async getLinksListOfFilesWithTags(
    activeFile: TFile,
    activeFileCache: CachedMetadata,
    forwardLinkSet: Set<string>,
    twoHopLinkSet: Set<string>
  ): Promise<PropertiesLinks[]> {
    const activeFileTags = this.getTagsFromCache(
      activeFileCache,
      this.settings.excludeTags
    );
    if (activeFileTags.length === 0) return [];

    const activeFileTagSet = new Set(activeFileTags);
    const tagMap: Record<string, FileEntity[]> = {};
    const seen: Record<string, boolean> = {};

    const markdownFiles = this.app.vault
      .getMarkdownFiles()
      .filter(
        (markdownFile: TFile) =>
          markdownFile !== activeFile &&
          !shouldExcludePath(markdownFile.path, this.settings.excludePaths)
      );

    for (const markdownFile of markdownFiles) {
      const cachedMetadata = this.app.metadataCache.getFileCache(markdownFile);
      if (!cachedMetadata) continue;

      const fileTags = this.getTagsFromCache(
        cachedMetadata,
        this.settings.excludePaths
      );

      for (const tag of fileTags) {
        if (!activeFileTagSet.has(tag)) continue;

        tagMap[tag] = tagMap[tag] ?? [];

        if (
          this.settings.enableDuplicateRemoval &&
          (seen[markdownFile.path] ||
            forwardLinkSet.has(filePathToLinkText(markdownFile.path)) ||
            twoHopLinkSet.has(filePathToLinkText(markdownFile.path)))
        )
          continue;

        const linkText = filePathToLinkText(markdownFile.path);
        const newFileEntity = new FileEntity(activeFile.path, linkText);

        if (
          !tagMap[tag].some(
            (existingEntity) =>
              existingEntity.sourcePath === newFileEntity.sourcePath &&
              existingEntity.linkText === newFileEntity.linkText
          )
        ) {
          tagMap[tag].push(newFileEntity);
        }
      }
    }

    const tagLinksEntities = await this.createPropertiesLinkEntities(
      this.settings,
      tagMap,
      "tags"
    );

    // Sort by the order tags appear in the active file (deduplicated, first occurrence)
    const tagOrderMap = new Map<string, number>();
    for (const tag of activeFileTags) {
      if (!tagOrderMap.has(tag)) {
        tagOrderMap.set(tag, tagOrderMap.size);
      }
    }
    return tagLinksEntities.sort((a, b) => {
      const aIndex = tagOrderMap.get(a.property) ?? Infinity;
      const bIndex = tagOrderMap.get(b.property) ?? Infinity;
      return aIndex - bIndex;
    });
  }

  async getLinksListOfFilesWithFrontmatterKeys(
    activeFile: TFile,
    activeFileCache: CachedMetadata,
    forwardLinkSet: Set<string>,
    twoHopLinkSet: Set<string>
  ): Promise<PropertiesLinks[]> {
    const activeFileFrontmatter = activeFileCache.frontmatter;
    if (!activeFileFrontmatter) return [];

    const frontmatterKeyMap: Record<string, Record<string, FileEntity[]>> = {};
    const seen: Record<string, boolean> = {};

    const markdownFiles = this.app.vault
      .getMarkdownFiles()
      .filter(
        (markdownFile: TFile) =>
          markdownFile !== activeFile &&
          !shouldExcludePath(markdownFile.path, this.settings.excludePaths)
      );

    for (const markdownFile of markdownFiles) {
      const cachedMetadata = this.app.metadataCache.getFileCache(markdownFile);
      if (!cachedMetadata) continue;

      const fileFrontmatter = cachedMetadata.frontmatter;
      if (!fileFrontmatter) continue;

      for (const [key, value] of Object.entries(fileFrontmatter)) {
        if (!this.settings.frontmatterKeys.includes(key)) continue;

        let values: string[] = [];
        let activeValues: string[] = [];

        if (typeof value === "string") {
          values.push(value);
        } else if (Array.isArray(value)) {
          values.push(...value);
        } else {
          continue;
        }

        if (activeFileFrontmatter[key]) {
          if (typeof activeFileFrontmatter[key] === "string") {
            activeValues.push(activeFileFrontmatter[key]);
          } else if (Array.isArray(activeFileFrontmatter[key])) {
            activeValues.push(...activeFileFrontmatter[key]);
          } else {
            continue;
          }
        } else {
          continue;
        }

        for (const activeValue of activeValues) {
          const activeValueHierarchy = activeValue.split("/");
          for (let i = activeValueHierarchy.length - 1; i >= 0; i--) {
            const hierarchicalActiveValue = activeValueHierarchy
              .slice(0, i + 1)
              .join("/");

            for (const value of values) {
              if (typeof value !== "string") {
                continue;
              }
              const valueHierarchy = value.split("/");
              const hierarchicalValue = valueHierarchy
                .slice(0, i + 1)
                .join("/");

              if (hierarchicalActiveValue !== hierarchicalValue) continue;

              frontmatterKeyMap[key] = frontmatterKeyMap[key] ?? {};
              frontmatterKeyMap[key][hierarchicalValue] =
                frontmatterKeyMap[key][hierarchicalValue] ?? [];

              if (
                this.settings.enableDuplicateRemoval &&
                (seen[markdownFile.path] ||
                  forwardLinkSet.has(filePathToLinkText(markdownFile.path)) ||
                  twoHopLinkSet.has(filePathToLinkText(markdownFile.path)))
              ) {
                continue;
              }

              const linkText = filePathToLinkText(markdownFile.path);
              frontmatterKeyMap[key][hierarchicalValue].push(
                new FileEntity(activeFile.path, linkText)
              );
              seen[markdownFile.path] = true;
            }
          }
        }
      }
    }

    const frontmatterKeyLinksEntities: PropertiesLinks[] = [];

    for (const [key, valueMap] of Object.entries(frontmatterKeyMap)) {
      const propertiesLinksEntities = await this.createPropertiesLinkEntities(
        this.settings,
        valueMap,
        key
      );

      frontmatterKeyLinksEntities.push(...propertiesLinksEntities);
    }

    const sortFunction = getTagHierarchySortFunction(this.settings.sortOrder);
    return frontmatterKeyLinksEntities.sort(sortFunction);
  }

  async createPropertiesLinkEntities(
    settings: any,
    propertiesMap: Record<string, FileEntity[]>,
    key: string = ""
  ): Promise<PropertiesLinks[]> {
    const propertiesLinksEntitiesPromises = Object.entries(propertiesMap).map(
      async ([property, entities]) => {
        const sortedEntities = await this.getSortedFileEntities(
          entities,
          (entity) => entity.sourcePath,
          settings.sortOrder
        );
        if (sortedEntities.length === 0) {
          return null;
        }
        return new PropertiesLinks(property, key, sortedEntities);
      }
    );

    const propertiesLinksEntities = await Promise.all(
      propertiesLinksEntitiesPromises
    );
    return propertiesLinksEntities.filter((it) => it != null);
  }

  getTagsFromCache(
    cache: CachedMetadata | null | undefined,
    excludeTags: string[]
  ): string[] {
    let tags: string[] = [];
    if (cache) {
      if (cache.tags) {
        cache.tags.forEach((it) => {
          const tagHierarchy = it.tag.replace("#", "").split("/");
          for (let i = 0; i < tagHierarchy.length; i++) {
            tags.push(tagHierarchy.slice(0, i + 1).join("/"));
          }
        });
      }

      if (cache.frontmatter?.tags) {
        if (Array.isArray(cache.frontmatter.tags)) {
          cache.frontmatter.tags.forEach((tag) => {
            if (typeof tag === "string") {
              const tagHierarchy = tag.split("/");
              for (let i = 0; i < tagHierarchy.length; i++) {
                tags.push(tagHierarchy.slice(0, i + 1).join("/"));
              }
            }
          });
        } else if (typeof cache.frontmatter.tags === "string") {
          cache.frontmatter.tags
            .split(",")
            .map((tag) => tag.trim())
            .forEach((tag) => {
              const tagHierarchy = tag.split("/");
              for (let i = 0; i < tagHierarchy.length; i++) {
                tags.push(tagHierarchy.slice(0, i + 1).join("/"));
              }
            });
        }
      }
    }

    return tags.filter((tag) => {
      for (const excludeTag of excludeTags) {
        if (
          excludeTag.endsWith("/") &&
          (tag === excludeTag.slice(0, -1) || tag.startsWith(excludeTag))
        ) {
          return false;
        }
        if (!excludeTag.endsWith("/") && tag === excludeTag) {
          return false;
        }
      }
      return true;
    });
  }

  async getSortedFileEntities(
    entities: FileEntity[],
    sourcePathFn: (entity: FileEntity) => string,
    sortOrder: string
  ): Promise<FileEntity[]> {
    const statsPromises = entities.map(async (entity) => {
      const stat = await this.app.vault.adapter.stat(sourcePathFn(entity));
      return { entity, stat };
    });

    const stats = (await Promise.all(statsPromises)).filter((it) => it);

    const sortFunction = getSortFunction(sortOrder);
    stats.sort(sortFunction);

    return stats.map((it) => it!.entity);
  }
}

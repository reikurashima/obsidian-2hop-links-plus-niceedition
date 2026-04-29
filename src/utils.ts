import { App, TAbstractFile, TFile } from "obsidian";

// is there a better way to get link text?
export function filePathToLinkText(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath.match(/\.md$/i)) {
    return normalizedPath.replace(/\.md$/i, "").replace(/.*\//, "");
  }
  return normalizedPath;
}

export function filePathToDisplayText(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\.(md|markdown|canvas)$/i, "")
    .replace(/.*\//, "");
}

// Remove block reference. e.g. `[[somefile#^7e8e5f]]`
export function removeBlockReference(src: string): string {
  return src.replace(/#.*$/, "");
}

export function resolveLinkFile(
  app: App,
  linkText: string,
  sourcePath: string
): TFile | null {
  const normalizedLinkText = removeBlockReference(linkText);
  const linkedFile = app.metadataCache.getFirstLinkpathDest(
    normalizedLinkText,
    sourcePath
  );
  if (linkedFile) {
    return linkedFile;
  }

  const directFile = app.vault.getAbstractFileByPath(normalizedLinkText);
  if (directFile instanceof TFile) {
    return directFile;
  }

  const basename = normalizedLinkText.replace(/.*\//, "");
  const matchingFile: TAbstractFile | undefined = app.vault
    .getFiles()
    .find((file) => file.name === basename || file.basename === basename);
  return matchingFile instanceof TFile ? matchingFile : null;
}

export function shouldExcludePath(
  path: string,
  excludePaths: string[]
): boolean {
  return excludePaths.some((excludePath: string) => {
    if (excludePath.endsWith("/")) {
      return path.startsWith(excludePath);
    } else {
      return path === excludePath;
    }
  });
}

import { FileEntity } from "./model/FileEntity";
import {
  filePathToDisplayText,
  removeBlockReference,
  resolveLinkFile,
} from "./utils";

export async function getTitle(fileEntity: FileEntity) {
  const linkText = removeBlockReference(fileEntity.linkText);
  const file = resolveLinkFile(
    this.app,
    fileEntity.linkText,
    fileEntity.sourcePath
  );

  if (!this.settings.frontmatterPropertyKeyAsTitle) {
    return file ? filePathToDisplayText(file.path) : linkText;
  }

  if (file == null) return linkText;
  if (!file.extension?.match(/^(md|markdown)$/)) {
    return filePathToDisplayText(file.path);
  }

  const metadata = this.app.metadataCache.getFileCache(file);

  if (
    !metadata.frontmatter ||
    !metadata.frontmatter[this.settings.frontmatterPropertyKeyAsTitle]
  )
    return linkText;

  const title =
    metadata.frontmatter[this.settings.frontmatterPropertyKeyAsTitle];
  return title;
}

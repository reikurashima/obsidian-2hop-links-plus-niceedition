import { FileEntity } from "./model/FileEntity";
import {
  filePathToDisplayText,
  removeBlockReference,
  resolveLinkFile,
} from "./utils";

export async function readPreview(fileEntity: FileEntity) {
  const linkText = removeBlockReference(fileEntity.linkText);

  if (fileEntity.linkText.match(/\.(png|bmp|jpg|jpeg|gif|svg|webp|avif)$/i)) {
    const file = resolveLinkFile(
      this.app,
      fileEntity.linkText,
      fileEntity.sourcePath
    );
    if (file) {
      const resourcePath = this.app.vault.getResourcePath(file);
      return resourcePath;
    }
  }

  if (
    fileEntity.linkText.match(/\.[a-z0-9_-]+$/i) &&
    !fileEntity.linkText.match(/\.(?:md|markdown|txt|text|canvas)$/i)
  ) {
    console.debug(`${fileEntity.linkText} is not a plain text file`);
    return "";
  }

  console.debug(
    `readPreview: getFirstLinkpathDest: ${linkText}, fileEntity.linkText=${fileEntity.linkText}
      sourcePath=${fileEntity.sourcePath}`
  );

  const file = resolveLinkFile(
    this.app,
    fileEntity.linkText,
    fileEntity.sourcePath
  );
  if (file == null) {
    return "";
  }
  if (file.stat.size > 1000 * 1000) {
    // Ignore large file
    console.debug(`File too large(${fileEntity.linkText}): ${file.stat.size}`);
    return "";
  }
  const content = await this.app.vault.cachedRead(file);

  if (file.extension === "canvas") {
    return readCanvasPreview(content);
  }

  const combinedMatch = content.match(
    /<iframe[^>]*src="([^"]+)"[^>]*>|!\[[^\]]*\]\((https:\/\/www\.youtube\.com\/embed\/[^\)]+|https:\/\/www\.youtube\.com\/watch\?v=[^\)]+|https:\/\/youtu\.be\/[^\)]+)\)|!\[(?:[^\]]*?)\]\(((?!https?:\/\/twitter\.com\/)[^\)]+?(?:png|bmp|jpg|jpeg|gif|svg|webp|avif))\)|!\[\[([^\]\|]+\.(?:png|bmp|jpg|jpeg|gif|svg|webp|avif))(?:\|[^\]]*)?\]\]/
  );
  if (combinedMatch) {
    const iframeUrl = combinedMatch[1];
    const youtubeEmbedUrl = combinedMatch[2];
    const img = combinedMatch[3] || combinedMatch[4];
    if (iframeUrl) {
      const thumbnailUrl = getThumbnailUrlFromIframeUrl(iframeUrl);
      if (thumbnailUrl) {
        return thumbnailUrl;
      }
    } else if (youtubeEmbedUrl) {
      const youtubeThumbnailUrl = getThumbnailUrlFromIframeUrl(youtubeEmbedUrl);
      if (youtubeThumbnailUrl) {
        return youtubeThumbnailUrl;
      }
    } else if (img) {
      console.debug(`Found image: ${img}`);
      if (img.match(/^https?:\/\//)) {
        return img;
      } else {
        const file = this.app.metadataCache.getFirstLinkpathDest(
          img,
          fileEntity.sourcePath
        );
        console.debug(`Found image: ${img} = file=${file}`);
        if (file) {
          const resourcePath = this.app.vault.getResourcePath(file);
          console.debug(`Found image: ${img} resourcePath=${resourcePath}`);
          return resourcePath;
        }
      }
    }
  }

  const externalThumbnailUrl = getThumbnailUrlFromContent(content);
  if (externalThumbnailUrl) {
    return externalThumbnailUrl;
  }

  const updatedContent = content.replace(/^(.*\n)?---[\s\S]*?---\n?/m, "");
  const lines = shortenExternalLinkInPreview(updatedContent).split(/\n/);
  return lines
    .filter((it: string) => {
      // Keep lines with content, exclude markdown headings (# ) but keep hashtags (#tag)
      return (
        it.match(/\S/) &&
        !it.match(/^#{1,6}\s/) &&
        !it.match(/^(https?|capacitor):\/\//)
      );
    })
    .slice(0, 6)
    .join("\n");
}

export function getThumbnailUrlFromIframeUrl(iframeUrl: string): string | null {
  const youtubeIdMatch = iframeUrl.match(
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([^?&/]+)(?:[/?][^?]+)?$|(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([^?&/]+)(?:\?[^?]+)?$|(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([^?&/]+)(?:\?[^?]+)?$|(?:https?:\/\/)?(?:youtu\.be\/)([^?&/]+)(?:\?[^?]+)?$/
  );
  if (youtubeIdMatch) {
    const youtubeId =
      youtubeIdMatch[1] ||
      youtubeIdMatch[2] ||
      youtubeIdMatch[3] ||
      youtubeIdMatch[4];
    return `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg`;
  }

  return null;
}

export function getThumbnailUrlFromContent(content: string): string | null {
  const youtubeUrlMatch = content.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:embed\/[^\s"'<>),]+|watch\?[^\s"'<>),]*v=[^\s"'<>),&]+|shorts\/[^\s"'<>),]+)|youtu\.be\/[^\s"'<>),]+)/i
  );
  if (youtubeUrlMatch) {
    const youtubeThumbnailUrl = getThumbnailUrlFromIframeUrl(
      youtubeUrlMatch[0].replace(/&amp;/g, "&")
    );
    if (youtubeThumbnailUrl) {
      return youtubeThumbnailUrl;
    }
  }

  const xDirectImageMatch = content.match(
    /https?:\/\/(?:pbs\.twimg\.com\/media|video\.twimg\.com\/tweet_video_thumb)\/[^\s"'<>),]+/i
  );
  if (xDirectImageMatch) {
    return xDirectImageMatch[0].replace(/&amp;/g, "&");
  }

  return null;
}

export function readCanvasPreview(content: string): string {
  try {
    const canvasData = JSON.parse(content);
    if (!Array.isArray(canvasData?.nodes)) {
      return "";
    }

    const previewLines: string[] = [];
    for (const node of canvasData.nodes) {
      if (node.type === "text" && typeof node.text === "string") {
        previewLines.push(node.text);
      } else if (node.type === "file" && typeof node.file === "string") {
        previewLines.push(filePathToDisplayText(node.file));
      }

      if (previewLines.length >= 6) {
        break;
      }
    }

    const lines: string[] = [];
    for (const previewLine of previewLines) {
      lines.push(...previewLine.split(/\n/));
    }

    return lines
      .filter((line) => line.match(/\S/))
      .slice(0, 6)
      .join("\n");
  } catch (error) {
    console.error("Invalid JSON in canvas:", error);
    return "";
  }
}

export function shortenExternalLinkInPreview(content: string): string {
  const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
  return content.replace(regex, "[$1](...)");
}

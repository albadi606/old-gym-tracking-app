import { OUTPUT_MIME_TYPE, OUTPUT_QUALITY } from '../domain/media/processing-contracts.ts';

/**
 * The browser side of photo ingestion.
 *
 * It is expressed as a port with a default implementation so the ingest rules can be
 * tested in jsdom, which has no canvas, without weakening what runs on a real phone.
 * Nothing here decides policy -- the limits and the rejection codes all live in
 * `domain/media/processing-contracts.ts`; this module only does the pixel work.
 */

export interface OpenedImage {
  widthPx: number;
  heightPx: number;
  /** Re-encodes the decoded pixels at the requested size. Always WebP. */
  encode(widthPx: number, heightPx: number): Promise<Blob>;
  /** Releases the decoded bitmap. Always called, including on failure. */
  close(): void;
}

export interface ImageProcessor {
  open(source: Blob): Promise<OpenedImage>;
}

function createCanvas(widthPx: number, heightPx: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(widthPx, heightPx);
  }
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  return canvas;
}

async function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Canvas encoding produced no data'));
          }
        },
        OUTPUT_MIME_TYPE,
        OUTPUT_QUALITY,
      );
    });
  }
  return canvas.convertToBlob({ type: OUTPUT_MIME_TYPE, quality: OUTPUT_QUALITY });
}

/**
 * Decodes with `createImageBitmap`, which rejects malformed bytes whatever the file
 * claimed to be, and applies the EXIF orientation so the stored pixels are upright.
 * Re-encoding through a canvas also drops every metadata tag the original carried,
 * including any location the camera recorded.
 */
export const browserImageProcessor: ImageProcessor = {
  async open(source: Blob): Promise<OpenedImage> {
    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    return {
      widthPx: bitmap.width,
      heightPx: bitmap.height,
      async encode(widthPx: number, heightPx: number): Promise<Blob> {
        const canvas = createCanvas(widthPx, heightPx);
        /*
         * Narrowed by a check rather than an assertion.
         *
         * `createCanvas` returns a union, and asking a union for `'2d'` widens the result
         * to `RenderingContext | null` -- which is why a cast used to stand here. A cast is
         * a claim; `'drawImage' in context` is a test, and it is the same test the next
         * line depends on. It also keeps the lint gate stable: whether a type-aware rule
         * considers a cast redundant depends on how the linter partitions the program,
         * and there is no reason for this line to be sensitive to that at all.
         */
        const context = canvas.getContext('2d');
        if (!context || !('drawImage' in context)) {
          throw new Error('Canvas 2D context is unavailable');
        }
        context.drawImage(bitmap, 0, 0, widthPx, heightPx);
        return canvasToBlob(canvas);
      },
      close(): void {
        bitmap.close();
      },
    };
  },
};

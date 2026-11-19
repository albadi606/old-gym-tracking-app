import { type ReactNode, useCallback, useState } from 'react';

import type { MediaRole } from '../domain/enums.ts';
import { type MediaAsset, selectMediaByRole } from '../domain/media/schemas.ts';
import { useStrings } from '../i18n/context.ts';
import { useBlobImageRef } from '../shared/useBlobImageRef.ts';

/**
 * Renders a machine photo, whichever way its bytes are stored.
 *
 * The asset is chosen by *role*, never by position in `imageAssetIds`, so reordering the
 * list can never turn a thumbnail into a detail image. Intrinsic `width` and `height` are
 * always supplied, and the placeholder keeps the same aspect ratio, so the grid reserves
 * its space before the image arrives and nothing jumps.
 *
 * Both failure modes are visible rather than silent: no photo at all, and a photo that
 * exists but will not decode.
 *
 * It lives in `components/` rather than in the machines feature because the workout's
 * strength picker chooses equipment by its photo too, and no feature may reach into
 * another's internals. Nothing about it is catalog-specific: it renders whichever asset
 * carries the requested role and knows nothing about why it is being shown.
 */
export interface MachinePhotoProps {
  assets: readonly MediaAsset[];
  role: MediaRole;
  className?: string;
  /** Cards below the fold load lazily; the detail image is the point of the page. */
  loading?: 'lazy' | 'eager';
}

export function MachinePhoto({
  assets,
  role,
  className,
  loading = 'lazy',
}: MachinePhotoProps): ReactNode {
  const strings = useStrings();
  const [failed, setFailed] = useState(false);
  const asset = selectMediaByRole(assets, role);
  const blob = asset?.storageKind === 'indexeddb_blob' ? asset.blob : undefined;
  const onPhotoFailure = useCallback(() => {
    setFailed(true);
  }, []);
  const blobRef = useBlobImageRef(blob, onPhotoFailure);
  const classes = `machine-photo ${className ?? ''}`.trim();

  if (!asset) {
    return (
      <div
        className={`${classes} machine-photo--empty`}
        role="img"
        aria-label={strings.pages.machines.photoMissing}
      >
        <span aria-hidden="true">&#9723;</span>
      </div>
    );
  }

  if (failed) {
    return (
      <div
        className={`${classes} machine-photo--empty`}
        role="img"
        aria-label={strings.pages.machines.photoFailed}
        style={{ aspectRatio: `${String(asset.widthPx)} / ${String(asset.heightPx)}` }}
      >
        <span aria-hidden="true">&#9723;</span>
      </div>
    );
  }

  const shared = {
    className: classes,
    alt: asset.altText,
    width: asset.widthPx,
    height: asset.heightPx,
    loading,
    decoding: 'async' as const,
    onError: onPhotoFailure,
  };

  if (asset.storageKind === 'static_url') {
    return <img src={asset.url} {...shared} />;
  }

  // A stored Blob has no address until one is minted; the ref does that and revokes it
  // again when this element goes away.
  return <img ref={blobRef} {...shared} />;
}

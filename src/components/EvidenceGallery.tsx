import { useEffect, useState } from "react";
import { fetchEvidenceBlob } from "../lib/api";
import type { EvidenceItem } from "../lib/types";

const slotLabels: Record<EvidenceItem["slot"], string> = {
  cover: "Portada",
  back_cover: "Contraportada",
  spine: "Lomo",
  interior: "Páginas interiores",
  damage: "Daños o anotaciones",
};

function EvidenceThumb({ item, accessToken }: { item: EvidenceItem; accessToken?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    fetchEvidenceBlob(item.id, accessToken)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [accessToken, item.id]);

  return (
    <figure className="evidence-thumb">
      {url ? <img src={url} alt={`${slotLabels[item.slot]} del libro ofrecido`} /> : <div className="evidence-placeholder">{failed ? "No disponible" : "Cargando…"}</div>}
      <figcaption>{slotLabels[item.slot]}</figcaption>
    </figure>
  );
}

export function EvidenceGallery({
  items,
  accessToken,
}: {
  items: EvidenceItem[];
  accessToken?: string;
}) {
  if (items.length === 0) return <p className="quiet">Sin fotografías registradas.</p>;
  return (
    <div className="evidence-gallery" aria-label="Fotografías del libro ofrecido">
      {items.map((item) => <EvidenceThumb key={item.id} item={item} accessToken={accessToken} />)}
    </div>
  );
}

import type { OpencodeImageAttachment } from "../types";
import { OpencodeAssetImage } from "./OpencodeAssetImage";
import styles from "./OpencodeAssetImage.module.css";

export function OpencodeImageAttachments(props: {
  images: OpencodeImageAttachment[];
  authMode?: "user" | "admin";
}) {
  if (!props.images.length) return null;
  return (
    <div className={styles.imageGrid}>
      {props.images.map((image) => (
        <OpencodeAssetImage key={image.path} path={image.path} alt={image.alt} authMode={props.authMode} />
      ))}
    </div>
  );
}

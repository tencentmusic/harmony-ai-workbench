"use client";

import { useLayoutEffect, useRef, useState } from "react";
import styles from "./MarqueeTitle.module.css";

type Props = {
  text: string;
  className?: string;
};

export function MarqueeTitle(props: Props) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [hover, setHover] = useState(false);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const check = () => setOverflow(inner.scrollWidth > wrap.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [props.text]);

  const showMarquee = hover && overflow;
  const displayText = showMarquee ? `${props.text}\u00A0\u00A0\u00A0${props.text}` : props.text;

  return (
    <span
      ref={wrapRef}
      className={`${styles.wrap} ${props.className || ""} ${showMarquee ? styles.marquee : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={overflow && !hover ? props.text : undefined}
    >
      <span ref={innerRef} className={styles.inner}>
        {displayText}
      </span>
    </span>
  );
}

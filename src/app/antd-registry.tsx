"use client";

import { useState, type ReactNode } from "react";
import { useServerInsertedHTML } from "next/navigation";
import { createCache, extractStyle, StyleProvider } from "@ant-design/cssinjs";

/**
 * antd 5 使用 cssinjs 1.x，而 @ant-design/nextjs-registry@1.3 绑的是 cssinjs 2.x。
 * 两份缓存互不相通，服务端抽不出组件样式，刷新时按钮和输入框会先裸奔再补上。
 * 这里改用 antd 自己的那一份缓存，把样式写进首屏 HTML。
 */
export function AntdStyleRegistry({ children }: { children: ReactNode }) {
  const [cache] = useState(() => createCache());

  useServerInsertedHTML(() => {
    const styleText = extractStyle(cache, { plain: true, once: true });
    return (
      <style
        id="antd-cssinjs"
        data-rc-order="prepend"
        data-rc-priority="-1000"
        dangerouslySetInnerHTML={{ __html: styleText }}
      />
    );
  });

  return <StyleProvider cache={cache}>{children}</StyleProvider>;
}

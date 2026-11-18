/** @type {import('next').NextConfig} */
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const antdDir = path.dirname(require.resolve("antd/package.json"));
// antd 5 依赖 cssinjs 1.x，但 @ant-design/nextjs-registry@1.3 把 cssinjs 2.x 提升到了顶层。
// 组件样式和样式缓存必须是同一份，否则刷新时按钮和输入框会先裸奔。
const cssinjsV1 = path.dirname(require.resolve("@ant-design/cssinjs/package.json", { paths: [antdDir] }));

const kbMcpProxyTarget =
  process.env.KB_MCP_PROXY_TARGET?.trim() || "http://127.0.0.1:8420";
const kbMcpCodegraphProxyTarget =
  process.env.KB_MCP_CODEGRAPH_PROXY_TARGET?.trim() || "http://127.0.0.1:8421";

const nextConfig = {
  webpack: (config) => {
    config.resolve.alias["@ant-design/cssinjs"] = cssinjsV1;
    return config;
  },
  turbopack: {
    resolveAlias: {
      "@ant-design/cssinjs": cssinjsV1,
    },
  },
  outputFileTracingIncludes: {
    "/api/package-comparison/*": ["./workers/package-comparison/*.mjs"],
    "/api/image-compression/*": ["./server/image-compression/*.py"],
  },
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    return [
      {
        source: "/kb-mcp-gateway/:path*",
        destination: `${kbMcpProxyTarget}/:path*`,
      },
      {
        source: "/kb-mcp-codegraph/:path*",
        destination: `${kbMcpCodegraphProxyTarget}/:path*`,
      },
    ];
  },
};

export default nextConfig;

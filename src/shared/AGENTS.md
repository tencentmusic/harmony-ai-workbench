# 前端共享层

仅接收至少两个前端模块稳定复用的 UI、hooks、API Client 与浏览器纯函数。不得放业务流程，不得导入
`src/server`；只有一个调用方的实现应回到所属 feature。

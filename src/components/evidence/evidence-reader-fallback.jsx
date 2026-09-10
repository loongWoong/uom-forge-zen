// 内置兜底证据阅读器
// ------------------------------------------------------------
// 业务文档视图的正常实现是子模块 qq-doc-clone 的 QQDocEditor（Forge 不复制其实现）。
// 子模块需要 `git submodule update --init` 才能检出；未检出时静态 import 会让 Vite
// 在 transform 阶段直接失败，整个工作台白屏。vite.config.js 在检测到子模块缺失时把
// `qq-doc-clone` 别名到本文件，因此主流程（证据分块、建模、校验、评估）仍然可用。
//
// props 契约与 QQDocEditor 保持一致：embedded / readOnly / initialTitle / initialContent。
// initialContent 已由 src/main.jsx 的 documentToHtml 处理过——HTML 走 DOMPurify.sanitize，
// Markdown/TXT 走逐行转义后再拼标签——所以这里的 innerHTML 与真实编辑器处于同一信任边界。
export default function EvidenceReaderFallback({ initialTitle = '', initialContent = '' }) {
  return (
    <div className="evidence-reader-fallback">
      <div className="evidence-fallback-notice" role="status">
        <strong>内置只读渲染</strong>
        <span>证据阅读组件 <code>qq-doc-clone</code> 未安装：排版与引文可用，批注与证据定位暂缺。执行 <code>git submodule update --init --recursive</code> 后自动恢复原组件。</span>
      </div>
      {initialTitle ? <h1 className="evidence-fallback-title">{initialTitle}</h1> : null}
      <article className="evidence-fallback-body" dangerouslySetInnerHTML={{ __html: initialContent || '<p></p>' }} />
    </div>
  )
}

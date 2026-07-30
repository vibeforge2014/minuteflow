import { FileArrowUp, FilePlus } from "@phosphor-icons/react";

export function EmptyState({ onNew, onImport }: { onNew(): void; onImport(): void }) {
  return (
    <div className="empty-state">
      <div><FilePlus size={32} weight="duotone" /></div>
      <h1>创建你的第一份会议文档</h1>
      <p>录音、转录、笔记与实时纪要都会安静地汇聚到同一个地方。</p>
      <div>
        <button className="button button--primary" onClick={onNew}>新建会议</button>
        <button className="button" onClick={onImport}><FileArrowUp size={16} />导入录音</button>
      </div>
    </div>
  );
}


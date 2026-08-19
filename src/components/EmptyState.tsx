/**
 * 空状态引导：中央工作区的落地页，区分两种情形——
 * first-run：没有任何会议，引导新建或导入；
 * search：搜索无结果（用户已有会议库），引导清除搜索而不是误以为数据丢失。
 */
import { FileArrowUp, FilePlus, MagnifyingGlass } from "@phosphor-icons/react";

export function EmptyState({
  variant = "first-run",
  onNew,
  onImport,
  onClear
}: {
  variant?: "first-run" | "search";
  onNew?(): void;
  onImport?(): void;
  /** search 变体：清除搜索词，回到全部会议列表。 */
  onClear?(): void;
}) {
  if (variant === "search") {
    return (
      <div className="empty-state">
        <div><MagnifyingGlass size={32} weight="duotone" /></div>
        <h1>没有找到匹配的会议</h1>
        <p>换个关键词试试，或清除搜索查看全部会议。</p>
        <div>
          <button className="button button--primary" onClick={onClear}>清除搜索</button>
        </div>
      </div>
    );
  }
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

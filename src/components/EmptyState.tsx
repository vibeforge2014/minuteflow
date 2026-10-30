/**
 * 空状态引导：中央工作区的落地页，区分两种情形——
 * first-run：没有任何会议，一键开始会议（零填写直录）或导入；
 * search：搜索无结果（用户已有会议库），引导清除搜索而不是误以为数据丢失。
 */
import { FileArrowUp, FilePlus, MagnifyingGlass } from "@phosphor-icons/react";

export function EmptyState({
  variant = "first-run",
  onNew,
  onTemplate,
  onImport,
  onClear
}: {
  variant?: "first-run" | "search";
  /** 一键开会：零填写、创建后立即录音转录。 */
  onNew?(): void;
  /** 需要模板/参与者等完整表单时的显式入口。 */
  onTemplate?(): void;
  onImport?(): void;
  /** search 变体：清除搜索词，回到全部会议列表。 */
  onClear?(): void;
}) {
  if (variant === "search") {
    return (
      <div className="empty-state">
        <div><MagnifyingGlass size={32} weight="duotone" /></div>
        <h1>没有找到匹配的会议</h1>
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
      <div>
        <button className="button button--primary" onClick={onNew} title="自动命名并立即开始录音">立即开始会议</button>
        <button className="button" onClick={onImport}><FileArrowUp size={16} />导入录音</button>
      </div>
      {onTemplate && (
        <button className="empty-state__link" onClick={onTemplate}>或使用模板创建会议</button>
      )}
    </div>
  );
}

import React, { useEffect, useRef } from "react";

export interface MoreMenuProps {
  /** 当前是否停在更多菜单内的页面（情境调整 / 已保存结果） */
  active: boolean;
  onOpenDemo: () => void;
  onOpenReplay: () => void;
  onOpenDataNote: () => void;
}

/**
 * “更多”菜单：情境调整 / 已保存结果 / 数据说明。
 * “我的出行”已提升为主导航一级入口（真实路线与群体推演分开）。
 * 外点或 Esc 关闭；菜单项回调只切视图，不改场景、不发请求。
 */
const ITEMS: { key: string; label: string; desc: string }[] = [
  { key: "demo", label: "情境调整", desc: "修改模拟输入：预设 / 自然语言 / 手动编辑" },
  { key: "replay", label: "已保存结果", desc: "回放查看 / 退出 / 保存管理" },
  { key: "data", label: "数据说明", desc: "模拟语义与能力边界" },
];

export default function MoreMenu({ active, onOpenDemo, onOpenReplay, onOpenDataNote }: MoreMenuProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (key: string) => {
    setOpen(false);
    if (key === "demo") onOpenDemo();
    else if (key === "replay") onOpenReplay();
    else onOpenDataNote();
  };

  return (
    <div className="shell-more" ref={rootRef}>
      <button
        className={`shell-nav-btn ${active ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        更多 ▾
      </button>
      {open && (
        <div className="shell-more-menu" role="menu">
          {ITEMS.map((item) => (
            <button key={item.key} role="menuitem" className="shell-more-item" onClick={() => run(item.key)}>
              <span className="shell-more-label">{item.label}</span>
              <span className="shell-more-desc">{item.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

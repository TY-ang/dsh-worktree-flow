/**
 * dsh-worktree-flow client bundle — hand-written in the lazy-CJS handoff
 * format (`window.__ModuleLoader__.load`), no build step required.
 *
 * Renders the "Worktree Flow" settings section: the management page for
 * feature workspaces. The domain object is the named SET — a group of
 * component repositories bound together, stored centrally. Two primary tabs:
 *   - 配置 (default): set list + editor. Component paths are bound explicitly
 *     (picker + probe, with a git-init escape hatch); inline validation and a
 *     dry-run create preview sit next to the form; a new set prefills from the
 *     "新套组模板" (read once). A collapsed card at the bottom edits that
 *     template.
 *   - 功能工作区: feature groups → component worktrees, with archive /
 *     cleanup / register actions.
 *
 * Data comes from the host's same-origin /worktree-flow/* HTTP endpoints
 * (see lib/http.js); the page itself never touches the filesystem.
 */
window.__ModuleLoader__.load({
  id: "dsh-worktree-flow",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    const STORAGE_KEY = "dsh-worktree-flow:project";

    // ------------------------------------------------------------------ api
    async function api(pathname, body, signal) {
      const init = body === undefined
        ? { cache: "no-store", signal }
        : { method: "POST", headers: { "content-type": "application/json", "x-worktree-flow-request": "1" }, body: JSON.stringify(body), signal };
      const response = await fetch(`/worktree-flow${pathname}`, init);
      const data = await response.json().catch(() => null);
      if (data === null || data.ok !== true) {
        const failure = new Error((data && data.error) || `请求失败（HTTP ${response.status}）`);
        if (data && typeof data.code === "string") failure.code = data.code;
        throw failure;
      }
      if (body !== undefined) invalidateClientCaches();
      return data;
    }

    // --------------------------------------------------------------- styles
    // 全部使用 DSH 设计 token（--dsw-alias-*），fallback 对齐浅色主题，避免深色
    // 主题下"主按钮品牌色翻转成近白、而文字仍写死 #fff"导致的白色按钮白字不可见。
    const C = {
      bg: "var(--dsw-alias-bg-layer-1, #ffffff)",
      bgRaised: "var(--dsw-alias-bg-layer-2, #ffffff)",
      border: "var(--dsw-alias-border-l2, rgba(0,0,0,0.1))",
      text: "var(--dsw-alias-label-primary, #0f1115)",
      dim: "var(--dsw-alias-label-tertiary, #81858c)",
      secondary: "var(--dsw-alias-label-secondary, #5e6470)",
      fillSoft: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,0.12))",
      faint: "var(--dsw-alias-label-caption, #9b9ea3)",
      brand: "var(--dsw-alias-brand-primary, #3964fe)",
      brandText: "var(--dsw-alias-brand-text, #3964fe)",
      error: "var(--dsw-alias-state-error-primary, #ec1313)",
      success: "var(--dsw-alias-state-success-primary, #18a058)",
      warn: "var(--dsw-alias-state-warn-primary, #f0a020)",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))",
      dangerHover: "var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,0.05))",
      buttonFill: "var(--dsw-alias-button-primary-fill, #0f1115)",
      buttonFillHover: "var(--dsw-alias-button-primary-hover, #434546)",
      buttonForeground: "var(--dsw-alias-label-primary-foreground, #ffffff)",
      elevatedFill: "var(--dsw-alias-button-elevated-fill, #ffffff)",
      mono: "var(--ds-font-family-code, Consolas, monospace)"
    };

    const S = {
      page: { display: "flex", flexDirection: "column", gap: 16, padding: "4px 2px", color: C.text, fontSize: 13, lineHeight: 1.6 },
      row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      card: { border: `1px solid ${C.border}`, borderRadius: 12, background: C.bg, padding: "14px 16px" },
      input: { padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.bgRaised, color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" },
      pill: { display: "inline-flex", alignItems: "center", padding: "2px 9px", borderRadius: 999, border: `1px solid ${C.border}`, fontSize: 11.5, color: C.dim },
      dim: { color: C.dim },
      faint: { color: C.faint, fontSize: 12 },
      mono: { fontFamily: C.mono, fontSize: 12 },
      errorBox: { border: `1px solid ${C.error}`, borderRadius: 8, padding: "8px 12px", color: C.error, fontSize: 12.5, whiteSpace: "pre-wrap" },
      modalMask: { position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" },
      modal: { width: 600, maxWidth: "calc(100vw - 40px)", maxHeight: "82vh", overflow: "auto", borderRadius: 16, background: C.bgRaised, color: C.text, padding: 22, boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }
    };

    // 按钮/标签/输入框用一份注入的样式表承载 :hover / :disabled / :focus，比
    // 内联样式 + JS 状态更稳，也顺手把尺寸、圆角、间距统一成 shell 的观感。
    function installUiStyles() {
      if (typeof document === "undefined") return () => {};
      const styleId = "dsh-worktree-flow-ui";
      const css = [
        `.wft-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:9px;border:1px solid ${C.border};background:${C.elevatedFill};color:${C.text};font-family:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}`,
        `.wft-btn:hover:not(:disabled){background:${C.hover}}`,
        `.wft-btn:disabled{cursor:not-allowed;opacity:.5}`,
        `.wft-btn--primary{background:${C.buttonFill};border-color:transparent;color:${C.buttonForeground};font-weight:500}`,
        `.wft-btn--primary:hover:not(:disabled){background:${C.buttonFillHover}}`,
        `.wft-btn--danger{background:transparent;border-color:${C.error};color:${C.error}}`,
        `.wft-btn--danger:hover:not(:disabled){background:${C.dangerHover}}`,
        `.wft-btn--sm{height:28px;padding:0 12px;border-radius:8px;font-size:12px}`,
        `.wft-tabbar{display:grid;grid-template-columns:1fr 1fr;gap:4px;width:100%;padding:4px;border:1px solid ${C.border};border-radius:12px;background:${C.bg}}`,
        `.wft-tab{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border-radius:9px;border:none;background:transparent;color:${C.dim};font-family:inherit;font-size:14px;cursor:pointer;transition:background .15s ease,color .15s ease}`,
        `.wft-tab:hover{color:${C.text};background:${C.hover}}`,
        `.wft-tab[data-active="true"]{background:${C.bgRaised};color:${C.text};font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08)}`,
        `.wft-disclosure{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 30px;padding:0;border-radius:8px;border:1px solid ${C.border};background:${C.elevatedFill};color:${C.dim};font-family:inherit;font-size:14px;cursor:pointer;transition:background .15s ease,color .15s ease}`,
        `.wft-disclosure:hover{background:${C.hover};color:${C.text}}`,
        `.wft-input{width:100%;padding:7px 12px;border-radius:8px;border:1px solid ${C.border};background:${C.bgRaised};color:${C.text};font-family:inherit;font-size:13px;outline:none;box-sizing:border-box;transition:border-color .15s ease,box-shadow .15s ease}`,
        `.wft-input:focus{border-color:${C.brand};box-shadow:0 0 0 3px ${C.hover}}`,
        `.wft-picker{position:relative;flex:1;min-width:0}`,
        `.wft-picker-btn{display:flex;align-items:center;gap:8px;width:100%;padding:7px 12px;border-radius:8px;border:1px solid ${C.border};background:${C.bgRaised};color:${C.text};font-family:inherit;font-size:13px;cursor:pointer;box-sizing:border-box;text-align:left;transition:border-color .15s ease,box-shadow .15s ease}`,
        `.wft-picker-btn:hover{border-color:${C.brand}}`,
        `.wft-picker-btn[data-open="true"]{border-color:${C.brand};box-shadow:0 0 0 3px ${C.hover}}`,
        `.wft-chevron{margin-left:auto;flex-shrink:0;color:${C.faint};font-size:11px;transition:transform .15s ease}`,
        `.wft-picker-btn[data-open="true"] .wft-chevron{transform:rotate(180deg)}`,
        `.wft-picker-menu{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:60;padding:4px;border:1px solid ${C.border};border-radius:10px;background:${C.bgRaised};box-shadow:0 12px 32px rgba(0,0,0,.35);max-height:280px;overflow-y:auto}`,
        `.wft-picker-item{display:flex;align-items:baseline;gap:8px;width:100%;padding:8px 10px;border:none;border-radius:7px;background:transparent;color:${C.text};font-family:inherit;font-size:13px;cursor:pointer;text-align:left;box-sizing:border-box}`,
        `.wft-picker-item:hover{background:${C.hover}}`
      ].join("");
      let tag = document.getElementById(styleId);
      if (tag === null) {
        tag = document.createElement("style");
        tag.id = styleId;
        document.head.appendChild(tag);
      }
      tag.textContent = css;
      return () => { if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag); };
    }

    function Button(props) {
      const className = [
        "wft-btn",
        props.primary ? "wft-btn--primary" : "",
        props.danger ? "wft-btn--danger" : "",
        props.small ? "wft-btn--sm" : ""
      ].filter(Boolean).join(" ");
      return jsx("button", {
        type: "button",
        disabled: props.disabled === true,
        onClick: props.onClick,
        title: props.title,
        className,
        children: props.children
      });
    }

    function Pill(props) {
      return jsx("span", { style: { ...S.pill, ...(props.color !== undefined ? { color: props.color, borderColor: props.color } : {}) }, children: props.children });
    }

    // 通用定制下拉（替代原生 <select>）：与输入框同一视觉语言——按钮态显示
    // 当前值，弹出菜单带 ✓ 选中标记与右侧弱化 hint。options: [{value, label,
    // hint?, mono?}]。宽度由调用方容器决定（.wft-picker 默认 flex:1）。
    function MiniPicker(props) {
      const { value, options, onChange, placeholder, fixed } = props;
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        const onDocDown = (e) => { if (rootRef.current !== null && !rootRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDocDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDocDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      const active = options.find((option) => option.value === value);
      const choose = (next) => { setOpen(false); onChange(next); };

      return jsxs("div", {
        className: "wft-picker",
        ref: rootRef,
        style: fixed === true ? { flex: "0 0 auto" } : undefined,
        children: [
          jsxs("button", {
            type: "button",
            className: "wft-picker-btn",
            "data-open": String(open),
            onClick: () => setOpen(!open),
            children: [
              active === undefined
                ? jsx("span", { style: { color: C.faint }, children: placeholder ?? "选择…" })
                : jsx("span", {
                    style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(active.mono === true ? { fontFamily: C.mono, fontSize: 12.5 } : {}) },
                    children: active.label
                  }),
              jsx("span", { className: "wft-chevron", children: "▾" })
            ]
          }),
          open && jsx("div", {
            className: "wft-picker-menu",
            style: { minWidth: "100%", width: "max-content", maxWidth: 380 },
            children: options.map((option) => jsxs("button", {
              type: "button",
              className: "wft-picker-item",
              onClick: () => choose(option.value),
              children: [
                jsx("span", { style: { width: 14, flexShrink: 0, color: C.brandText, fontSize: 12 }, children: option.value === value ? "✓" : "" }),
                jsx("span", { style: { whiteSpace: "nowrap", ...(option.mono === true ? { fontFamily: C.mono, fontSize: 12.5 } : {}) }, children: option.label }),
                option.hint !== undefined && option.hint !== "" && jsx("span", { style: { color: C.faint, fontSize: 12, marginLeft: "auto", paddingLeft: 16, whiteSpace: "nowrap" }, children: option.hint })
              ]
            }, option.value))
          })
        ]
      });
    }

    function Field(props) {
      return jsxs("label", {
        style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 200, flex: 1 },
        children: [
          jsx("span", { style: { fontSize: 12.5, fontWeight: 500, color: C.dim }, children: props.label }),
          jsx("input", { value: props.value, onChange: (e) => props.onChange(e.target.value), placeholder: props.placeholder, style: S.input })
        ]
      });
    }

    function gitBadges(git) {
      if (git === undefined || git.present !== true) return [jsx(Pill, { color: C.error, children: "缺失" }, "missing")];
      const out = [jsx(Pill, { color: git.branchMismatch === true ? C.error : undefined, children: git.branch ?? "detached" }, "branch")];
      if (git.ownershipMismatch === true) out.push(jsx(Pill, { color: C.error, children: "所有权异常" }, "ownership"));
      else if (git.readError !== undefined) out.push(jsx(Pill, { color: C.error, children: "状态未知" }, "read-error"));
      if ((git.changed ?? 0) > 0) out.push(jsx(Pill, { color: C.warn, children: `${git.changed} 未提交` }, "changed"));
      if ((git.ahead ?? 0) > 0) out.push(jsx(Pill, { children: `领先 ${git.ahead}` }, "ahead"));
      if ((git.behind ?? 0) > 0) out.push(jsx(Pill, { children: `落后 ${git.behind}` }, "behind"));
      if ((git.unpushed ?? 0) > 0) out.push(jsx(Pill, { color: C.warn, children: `未推送 ${git.unpushed}` }, "unpushed"));
      if (out.length === 1 && git.branchMismatch !== true) out.push(jsx(Pill, { color: C.success, children: "干净" }, "clean"));
      return out;
    }

    // 内置分支类型兜底（/branch-types 拉取失败时向导仍可用；与服务端
    // DEFAULT_BRANCH_TYPES 保持一致）。
    const BUILTIN_BRANCH_TYPES = [
      { key: "bugfix", label: "Bugfix", prefix: "bugfix/" },
      { key: "feature", label: "功能", prefix: "feature/" },
      { key: "hotfix", label: "Hotfix", prefix: "hotfix/" },
      { key: "release", label: "发布", prefix: "release/" }
    ];

    // ------------------------------------------------------- create wizard
    function CreateWizard(props) {
      const { config, onClose, onCreated } = props;
      const knownComponents = Object.keys(config.repositories);
      const [picked, setPicked] = useState(() => [...knownComponents]);
      const [types, setTypes] = useState(null);
      const [typeKey, setTypeKey] = useState("feature");
      const [topic, setTopic] = useState("");
      const [base, setBase] = useState("");
      const [sessionInstructions, setSessionInstructions] = useState("");
      const [registerComponents, setRegisterComponents] = useState(false);
      const [preview, setPreview] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const abortRef = useRef(null);

      // 全局分支类型词汇表（首次读取时服务端会把内置项落盘）。
      useEffect(() => {
        let cancelled = false;
        api("/branch-types")
          .then((data) => { if (!cancelled && Array.isArray(data.types) && data.types.length > 0) setTypes(data.types); })
          .catch(() => { /* 兜底用内置 */ });
        return () => { cancelled = true; };
      }, []);

      const list = types ?? BUILTIN_BRANCH_TYPES;
      const activeType = list.find((entry) => entry.key === typeKey);
      const custom = typeKey === "custom" || activeType === undefined;
      const topicSlug = custom ? topic.trim() : slugifyClient(topic);
      const branchPreview = topicSlug === "" ? "" : custom ? topicSlug : `${activeType.prefix}${topicSlug}`;

      // 功能标识由服务端从分支名最后一段派生（feature/selection-v2 → selection-v2）。
      const intent = useMemo(() => ({
        feature: "",
        components: picked,
        branch: branchPreview,
        baseBranch: base.trim() === "" ? undefined : base.trim(),
        sessionInstructions,
        registerComponents
      }), [picked, branchPreview, base, sessionInstructions, registerComponents]);

      // 输入一变旧预览即过期——「确认创建」的冲突禁用判断必须基于当前计划。
      useEffect(() => { setPreview(null); }, [intent]);

      const doPreview = useCallback(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true); setError(null);
        try {
          const data = await api("/create", { set: props.set, intent: { ...intent, dryRun: true } }, controller.signal);
          setPreview(data.result);
        } catch (cause) { if (!controller.signal.aborted) setError(cause.message); setPreview(null); }
        finally { if (abortRef.current === controller) abortRef.current = null; setBusy(false); }
      }, [intent, props.set]);

      const doCreate = useCallback(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true); setError(null);
        try {
          const data = await api("/create", { set: props.set, intent }, controller.signal);
          onCreated(data.result);
        } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
        finally { if (abortRef.current === controller) abortRef.current = null; setBusy(false); }
      }, [intent, props.set, onCreated]);
      const cancel = useCallback(() => { abortRef.current?.abort(); onClose(); }, [onClose]);

      const ready = branchPreview !== "" && picked.length > 0;
      const wizardLabel = { fontSize: 12, color: C.dim };
      const typeOptions = [
        ...list.map((entry) => ({ value: entry.key, label: entry.prefix !== "" ? entry.prefix : entry.label, mono: true, hint: entry.label })),
        { value: "custom", label: "自定义" }
      ];

      return jsx("div", {
        style: S.modalMask,
        children: jsxs("div", {
          style: S.modal,
          children: [
            jsxs("div", {
              style: { display: "flex", alignItems: "center", gap: 10, paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${C.border}` },
              children: [
                jsx("span", { style: { fontSize: 15, fontWeight: 600 }, children: "创建功能工作区" }),
                jsx("span", { style: { ...S.pill, fontFamily: C.mono }, children: props.set })
              ]
            }),
            jsxs("div", {
              style: { display: "flex", flexDirection: "column", gap: 14 },
              children: [
                jsxs("div", {
                  style: { display: "grid", gridTemplateColumns: "128px minmax(0,1fr) 156px", gap: 12, alignItems: "end" },
                  children: [
                    jsxs("div", {
                      style: { display: "flex", flexDirection: "column", gap: 6 },
                      children: [
                        jsx("span", { style: wizardLabel, children: "分支类型" }),
                        jsx(MiniPicker, {
                          value: typeKey,
                          onChange: setTypeKey,
                          options: typeOptions
                        })
                      ]
                    }),
                    jsxs("label", {
                      style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
                      children: [
                        jsx("span", { style: wizardLabel, children: custom ? "完整分支名" : "分支主题" }),
                        jsx("input", {
                          value: topic,
                          autoFocus: true,
                          onChange: (e) => setTopic(e.target.value),
                          placeholder: custom ? "如 feature/selection-v2" : "如 selection-v2",
                          style: S.input
                        })
                      ]
                    }),
                    jsxs("label", {
                      style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
                      children: [
                        jsx("span", { style: wizardLabel, children: "基准分支" }),
                        jsx("input", {
                          value: base,
                          onChange: (e) => setBase(e.target.value),
                          placeholder: `默认 ${config.defaultBaseBranch}`,
                          style: S.input
                        })
                      ]
                    })
                  ]
                }),
                branchPreview !== "" && jsx("div", { style: { ...S.faint, ...S.mono, fontSize: 12, marginTop: -6 }, children: `→ ${branchPreview}` }),
                jsxs("label", {
                  style: { display: "flex", flexDirection: "column", gap: 6 },
                  children: [
                    jsx("span", { style: wizardLabel, children: "功能区会话说明（可选）" }),
                    jsx("textarea", {
                      className: "wft-input",
                      style: { minHeight: 92, resize: "vertical", lineHeight: 1.55, fontFamily: C.mono, fontSize: 12 },
                      value: sessionInstructions,
                      maxLength: 16384,
                      onChange: (e) => setSessionInstructions(e.target.value),
                      placeholder: "例如：本分支 SQL 放在 backend/sql/selection-v2；修改接口前先阅读共享 docs 原始目录中的设计说明。"
                    }),
                    jsx("span", { style: S.faint, children: "保存为该功能区的可信上下文；以后在此功能区新建的每个会话都会在首步收到。" })
                  ]
                }),
                jsxs("div", {
                  children: [
                    jsx("div", { style: { ...wizardLabel, marginBottom: 8 }, children: "组件" }),
                    jsx("div", {
                      style: { display: "flex", flexWrap: "wrap", gap: 8 },
                      children: knownComponents.map((name) => {
                        const checked = picked.includes(name);
                        const label = config.repositories[name].label ?? name;
                        return jsxs("label", {
                          style: {
                            display: "inline-flex", alignItems: "center", gap: 7,
                            padding: "5px 12px", borderRadius: 999, cursor: "pointer", fontSize: 12.5,
                            border: `1px solid ${checked ? C.brandText : C.border}`,
                            background: checked ? C.hover : "transparent",
                            color: checked ? C.text : C.dim
                          },
                          children: [
                            jsx("input", {
                              type: "checkbox",
                              style: { margin: 0 },
                              checked,
                              onChange: (e) => setPicked((prev) => e.target.checked ? [...prev, name] : prev.filter((x) => x !== name))
                            }),
                            jsx("span", { children: label }),
                            label !== name && jsx("span", { style: { ...S.faint, ...S.mono }, children: name })
                          ]
                        }, name);
                      })
                    })
                  ]
                }),
                jsxs("label", {
                  style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.dim, cursor: "pointer" },
                  title: "各组件目录也单独出现在侧边栏（一般用不到）",
                  children: [
                    jsx("input", { type: "checkbox", checked: registerComponents, onChange: (e) => setRegisterComponents(e.target.checked) }),
                    "同时登记各组件为独立工作区"
                  ]
                }),
                preview !== null && Array.isArray(preview.plan) && jsxs("div", {
                  style: { ...S.card, background: C.bgRaised },
                  children: [
                    jsxs("div", { style: { marginBottom: 6 }, children: ["计划：", jsx("b", { children: preview.title }), `  根目录 `, jsx("span", { style: S.mono, children: preview.featureRoot })] }),
                    preview.context?.hasInstructions === true && jsx("div", { style: { fontSize: 12.5, padding: "3px 0", color: C.success }, children: `✓ 将保存功能区会话说明（${preview.context.instructionBytes} bytes）` }),
                    preview.context?.docs !== undefined && jsxs("div", {
                      style: { fontSize: 12.5, padding: "3px 0", color: C.text },
                      children: [
                        jsx("b", { children: "共享 docs 原始目录" }),
                        jsx("span", { style: { ...S.mono, color: C.dim }, children: `  ${preview.context.docs.sourcePath}` }),
                        jsx("div", { style: S.faint, children: preview.context.docs.note })
                      ]
                    }),
                    preview.plan.map((row) => jsxs("div", {
                      style: { fontSize: 12.5, padding: "3px 0", color: row.conflict ? C.error : C.text },
                      children: [
                        jsx("b", { children: row.component }),
                        jsx("span", { style: { color: C.dim }, children: `  ${row.repository} → ` }),
                        jsx("span", { style: S.mono, children: row.targetPath }),
                        jsx("div", { style: { ...S.faint, color: row.conflict ? C.error : C.faint }, children: row.note })
                      ]
                    }, row.component))
                  ]
                }),
                error !== null && jsx("div", { style: S.errorBox, children: error }),
                jsxs("div", {
                  style: { display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 14, borderTop: `1px solid ${C.border}` },
                  children: [
                    jsx(Button, { onClick: cancel, children: busy ? "取消操作" : "取消" }),
                    jsx(Button, { onClick: doPreview, disabled: busy || !ready, children: "预览计划" }),
                    jsx(Button, { primary: true, onClick: doCreate, disabled: busy || !ready || (preview !== null && ((Array.isArray(preview.plan) && preview.plan.some((row) => row.conflict)) || preview.context?.docs?.conflict === true)), children: busy ? "创建中…" : "确认创建" })
                  ]
                })
              ]
            })
          ]
        })
      });
    }

    // ------------------------------------------------------ cleanup modal
    function CleanupModal(props) {
      const { feature, set, onClose, onDone } = props;
      const [plan, setPlan] = useState(null);
      const [force, setForce] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const abortRef = useRef(null);

      useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        api("/cleanup/plan", { set, feature: feature.feature }, controller.signal)
          .then((data) => { if (!cancelled) setPlan(data.plan); })
          .catch((cause) => { if (!cancelled && !controller.signal.aborted) setError(cause.message); });
        return () => { cancelled = true; controller.abort(); };
      }, [set, feature.feature]);

      const blocked = plan !== null && plan.blockers.length > 0;
      const fatal = plan !== null && Array.isArray(plan.fatalBlockers) && plan.fatalBlockers.length > 0;
      const run = useCallback(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true); setError(null);
        try {
          const data = await api("/cleanup", { set, feature: feature.feature, force }, controller.signal);
          onDone(data.result);
        } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
        finally { if (abortRef.current === controller) abortRef.current = null; setBusy(false); }
      }, [set, feature.feature, force, onDone]);
      const cancel = useCallback(() => { abortRef.current?.abort(); onClose(); }, [onClose]);

      return jsx("div", {
        style: S.modalMask,
        children: jsxs("div", {
          style: S.modal,
          children: [
            jsx("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 }, children: `清理 ${feature.projectName}/${feature.feature}` }),
            jsx("div", { style: { ...S.faint, marginBottom: 12 }, children: "将删除各组件 worktree 目录并注销工作区登记（分支与远程提交不受影响）。此操作不可撤销。" }),
            plan === null && error === null && jsx("div", { style: S.dim, children: "检查中…" }),
            plan !== null && jsxs("div", {
              style: { display: "flex", flexDirection: "column", gap: 8 },
              children: [
                plan.components.map((row) => jsxs("div", {
                  style: { fontSize: 12.5 },
                  children: [
                    jsx("b", { children: row.component }),
                    jsx("span", { style: { ...S.mono, ...S.dim }, children: `  ${row.path}` }),
                    row.note !== undefined
                      ? jsx("div", { style: S.faint, children: row.note })
                      : row.ok === true
                        ? jsx("div", { style: { color: C.success, fontSize: 12 }, children: "干净，可删除" })
                        : jsx("div", { style: { color: C.warn, fontSize: 12 }, children: (row.blockers ?? []).join("；") })
                  ]
                }, row.component)),
                blocked && !fatal && jsxs("label", {
                  style: { display: "flex", alignItems: "center", gap: 6, color: C.warn, fontSize: 12.5, cursor: "pointer" },
                  children: [
                    jsx("input", { type: "checkbox", checked: force, onChange: (e) => setForce(e.target.checked) }),
                    "我已知晓上述风险（未推送/未提交内容将丢失），仍要强制清理"
                  ]
                })
              ]
            }),
            error !== null && jsx("div", { style: { ...S.errorBox, marginTop: 8 }, children: error }),
            jsxs("div", {
              style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
              children: [
                jsx(Button, { onClick: cancel, children: busy ? "取消操作" : "取消" }),
                jsx(Button, { danger: true, onClick: run, disabled: busy || plan === null || fatal || (blocked && !force), children: busy ? "清理中…" : "确认清理" })
              ]
            })
          ]
        })
      });
    }

    // ------------------------------------------------------- feature card
    function FeatureCard(props) {
      const { feature, set, onAction } = props;
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState("");
      const [instructions, setInstructions] = useState("");
      const [savedInstructions, setSavedInstructions] = useState("");
      const [instructionsLoaded, setInstructionsLoaded] = useState(false);
      const [instructionsBusy, setInstructionsBusy] = useState(false);
      const [instructionsError, setInstructionsError] = useState(null);
      const registered = feature.registration.state === "registered";
      const archived = feature.archived === true || feature.status === "archived";

      const act = useCallback(async (label, fn) => {
        setBusy(label);
        try { await fn(); onAction(); }
        catch (cause) { onAction(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(""); }
      }, [onAction]);

      useEffect(() => {
        setInstructions("");
        setSavedInstructions("");
        setInstructionsLoaded(false);
        setInstructionsError(null);
      }, [set, feature.feature]);

      useEffect(() => {
        if (!open || instructionsLoaded) return undefined;
        let cancelled = false;
        setInstructionsBusy(true); setInstructionsError(null);
        api(`/feature-instructions?set=${encodeURIComponent(set)}&feature=${encodeURIComponent(feature.feature)}`)
          .then((data) => {
            if (cancelled) return;
            const value = data.result?.sessionInstructions ?? "";
            setInstructions(value); setSavedInstructions(value); setInstructionsLoaded(true);
          })
          .catch((cause) => { if (!cancelled) setInstructionsError(cause instanceof Error ? cause.message : String(cause)); })
          .finally(() => { if (!cancelled) setInstructionsBusy(false); });
        return () => { cancelled = true; };
      }, [open, instructionsLoaded, set, feature.feature]);

      const saveInstructions = useCallback(async () => {
        setInstructionsBusy(true); setInstructionsError(null);
        try {
          const data = await api("/feature-instructions", { set, feature: feature.feature, sessionInstructions: instructions });
          const value = data.result?.sessionInstructions ?? "";
          setInstructions(value); setSavedInstructions(value); setInstructionsLoaded(true);
        } catch (cause) {
          setInstructionsError(cause instanceof Error ? cause.message : String(cause));
        } finally { setInstructionsBusy(false); }
      }, [set, feature.feature, instructions]);

      return jsxs("div", {
        style: S.card,
        children: [
          jsxs("div", {
            style: { ...S.row, cursor: "pointer", userSelect: "none" },
            onClick: () => setOpen(!open),
            children: [
              jsx("span", { style: { fontSize: 11, color: C.faint, width: 12 }, children: open ? "▾" : "▸" }),
              jsxs("b", { style: { fontSize: 13.5 }, children: [jsx("span", { style: { color: C.dim, fontWeight: 500 }, children: `${feature.projectName}/` }), feature.feature] }),
              archived ? jsx(Pill, { color: C.faint, children: "已归档" }) : null,
              jsx(Pill, { color: feature.status === "ready" ? C.success : feature.status === "partial" ? C.warn : C.error, children: feature.status }),
              registered
                ? jsx(Pill, { color: C.brandText, children: `已登记 · ${feature.registration.sessionCount ?? 0} 会话` })
                : jsx(Pill, { children: "未登记" }),
              feature.legacyManifest === true ? jsx(Pill, { color: C.warn, children: "旧清单" }) : null
            ]
          }),
          open && jsxs("div", {
            style: { marginTop: 10, display: "flex", flexDirection: "column", gap: 8 },
            children: [
              jsx("div", { style: { ...S.faint, ...S.mono }, children: [feature.root] }),
              Object.values(feature.components).map((component) => jsxs("div", {
                style: { border: `1px solid ${C.border}`, borderRadius: 8, background: C.bgRaised, padding: "6px 10px", display: "flex", flexDirection: "column", gap: 3 },
                children: [
                  jsxs("div", {
                    style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
                    children: [
                      jsx("span", { style: { minWidth: 72, fontWeight: 600 }, children: component.name }),
                      ...gitBadges(component.git),
                      component.registration?.state === "registered" ? jsx(Pill, { color: C.brandText, children: "独立登记" }) : null,
                      component.state === "failed" ? jsx(Pill, { color: C.error, children: `失败：${component.error ?? ""}` }) : null
                    ]
                  }),
                  jsx("span", { style: { ...S.faint, ...S.mono, fontSize: 11.5, paddingLeft: 80 }, children: component.path }),
                  component.git?.ownershipMismatch === true
                    ? jsx("div", { style: { color: C.error, fontSize: 11.5, paddingLeft: 80, whiteSpace: "pre-wrap" }, children: "该 worktree 的 Windows 所有者与当前用户不一致。插件没有修改 safe.directory 或目录所有者；请使用与 IDEA 相同的普通用户启动 DSH，修正目录所有者或重新创建后重试。" })
                    : null
                ]
              }, component.name)),
              jsxs("div", {
                style: { border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 6 },
                children: [
                  jsx("div", { style: { fontSize: 12.5, fontWeight: 600 }, children: "功能区会话说明" }),
                  jsx("textarea", {
                    className: "wft-input",
                    style: { minHeight: 84, resize: "vertical", lineHeight: 1.55 },
                    value: instructions,
                    disabled: instructionsBusy && !instructionsLoaded,
                    onChange: (e) => setInstructions(e.target.value),
                    placeholder: instructionsBusy && !instructionsLoaded ? "加载中…" : "可选：该功能区/分支专用的 SQL 目录、联调方式或其他约定"
                  }),
                  jsxs("div", {
                    style: { ...S.row, justifyContent: "space-between", alignItems: "center" },
                    children: [
                      jsx("span", { style: S.faint, children: "保存后，该功能区之后创建的新会话会注入最新内容；项目会话说明仍会同时注入。" }),
                      jsx(Button, {
                        small: true,
                        onClick: saveInstructions,
                        disabled: instructionsBusy || !instructionsLoaded || instructions === savedInstructions,
                        children: instructionsBusy ? "保存中…" : "保存说明"
                      })
                    ]
                  }),
                  instructionsError !== null ? jsx("div", { style: { color: C.error, fontSize: 11.5, whiteSpace: "pre-wrap" }, children: instructionsError }) : null
                ]
              }),
              jsxs("div", {
                style: { ...S.row, gap: 8 },
                children: [
                  registered
                    ? jsx(Button, { small: true, disabled: busy !== "", onClick: () => act("unregister", () => api("/unregister", { set, feature: feature.feature })), children: "从侧边栏下架" })
                    : jsx(Button, { small: true, disabled: busy !== "", onClick: () => act("register", () => api("/register", { set, feature: feature.feature })), children: "登记到侧边栏" }),
                  !archived && jsx(Button, { small: true, disabled: busy !== "", onClick: () => act("archive", () => api("/archive", { set, feature: feature.feature })), title: "标记归档并默认下架（文件与分支保留）", children: "归档" }),
                  jsx(Button, { danger: true, small: true, disabled: busy !== "", onClick: props.onCleanup, title: "删除 worktree 目录并注销登记（二次确认）", children: "清理…" }),
                  registered && jsx("span", { style: S.faint, children: "开会话：侧边栏工作区列表 / 新建会话选择器里选它" })
                ]
              })
            ]
          })
        ]
      });
    }

    // ------------------------------------------- new-set template (collapsed)
    // 模板只在"新建套组"时被读取一次，作为预填值；不参与任何运行时
    // 合并，也不影响已配置项目。折叠展示，展开时才加载。
    function TemplateCard() {
      const [open, setOpen] = useState(false);
      return jsxs("div", {
        style: { ...S.card, display: "flex", flexDirection: "column", gap: open ? 12 : 0 },
        children: [
          jsxs("div", {
            style: { ...S.row, cursor: "pointer", userSelect: "none", justifyContent: "space-between" },
            onClick: () => setOpen(!open),
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: 8 },
                children: [
                  jsx("span", { style: { fontSize: 11, color: C.faint, width: 12 }, children: open ? "▾" : "▸" }),
                  jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: "新仓库组模板" }),
                  jsx("span", { style: S.faint, children: "新建仓库组时的预填值与组件词汇表" })
                ]
              }),
              jsx("span", { style: S.faint, children: open ? "收起" : "编辑" })
            ]
          }),
          open && jsx(TemplateForm, {})
        ]
      });
    }

    function TemplateForm() {
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [savedAt, setSavedAt] = useState(null);
      const [newRepoName, setNewRepoName] = useState("");

      useEffect(() => {
        let cancelled = false;
        api("/template")
          .then((data) => { if (!cancelled) setDraft(data.configured === true ? data.config : { worktreeRoot: "", defaultBaseBranch: "", repositories: {} }); })
          .catch((cause) => { if (!cancelled) setError(cause.message); });
        return () => { cancelled = true; };
      }, []);

      const update = (field, value) => setDraft((prev) => ({ ...prev, [field]: value }));
      const updateRepo = (name, field, value) => setDraft((prev) => ({ ...prev, repositories: { ...prev.repositories, [name]: { ...prev.repositories[name], [field]: value } } }));
      const removeRepo = (name) => setDraft((prev) => { const repositories = { ...prev.repositories }; delete repositories[name]; return { ...prev, repositories }; });
      const addRepo = () => {
        const name = newRepoName.trim();
        if (name === "" || draft === null || draft.repositories[name] !== undefined) return;
        setDraft((prev) => ({ ...prev, repositories: { ...prev.repositories, [name]: {} } }));
        setNewRepoName("");
      };
      const save = async () => {
        if (draft === null) return;
        // The template carries the component vocabulary only; strip any paths.
        const normalized = {
          worktreeRoot: draft.worktreeRoot ?? "",
          defaultBaseBranch: draft.defaultBaseBranch ?? "",
          repositories: Object.fromEntries(Object.entries(draft.repositories).map(([name, repo]) => [name, {
            ...(repo.label ? { label: repo.label } : {}),
            ...(repo.defaultBaseBranch ? { defaultBaseBranch: repo.defaultBaseBranch } : {})
          }]))
        };
        setBusy(true); setError(null);
        try { await api("/template", { config: normalized }); setDraft(normalized); setSavedAt(new Date()); }
        catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
      };

      if (draft === null) return jsx("div", { style: S.card, children: error !== null ? error : "加载中…" });

      return jsxs("div", {
        style: { ...S.card, display: "flex", flexDirection: "column", gap: 16 },
        children: [
          jsxs("div", {
            style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
            children: [
              jsx(Field, { label: "工作区根目录（预填值）", value: draft.worktreeRoot ?? "", onChange: (v) => update("worktreeRoot", v), placeholder: "如 ~/worktree 或 D:\\workspace\\worktree" }),
              jsx(Field, { label: "默认基准分支（预填值）", value: draft.defaultBaseBranch ?? "", onChange: (v) => update("defaultBaseBranch", v), placeholder: "如 master / main" })
            ]
          }),
          jsxs("div", {
            style: { display: "flex", flexDirection: "column", gap: 10 },
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
                children: [
                  jsx("div", { style: { fontSize: 13, fontWeight: 600 }, children: "组件词汇表" }),
                  jsx(Pill, { children: `${Object.keys(draft.repositories).length} 个组件` })
                ]
              }),
              // 词汇表行：与项目配置的组件行同一风格——一行紧凑布局，
              // 标识 + 显示名 + 基准分支 + 删除，不再用大卡片。
              ...Object.entries(draft.repositories).map(([name, repo]) => jsxs("div", {
                style: { display: "grid", gridTemplateColumns: "96px minmax(0,1fr) minmax(0,1fr) auto", gap: 8, alignItems: "center", border: `1px solid ${C.border}`, borderRadius: 8, background: C.bgRaised, padding: "6px 10px" },
                children: [
                  jsx("span", { style: { ...S.mono, fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: name, children: name }),
                  jsx("input", { className: "wft-input", value: repo.label ?? "", onChange: (e) => updateRepo(name, "label", e.target.value), placeholder: "显示名（可选）" }),
                  jsx("input", { className: "wft-input", value: repo.defaultBaseBranch ?? "", onChange: (e) => updateRepo(name, "defaultBaseBranch", e.target.value), placeholder: `基准分支，留空用 ${draft.defaultBaseBranch || "master"}` }),
                  jsx(Button, { danger: true, small: true, onClick: () => removeRepo(name), children: "删除" })
                ]
              }, name)),
              jsxs("div", {
                style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "center", border: `1px dashed ${C.border}`, borderRadius: 10, padding: 10 },
                children: [
                  jsx("input", {
                    className: "wft-input",
                    value: newRepoName,
                    onChange: (e) => setNewRepoName(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") addRepo(); },
                    placeholder: "输入新组件标识，如 frontend"
                  }),
                  jsx(Button, { onClick: addRepo, disabled: newRepoName.trim() === "", children: "+ 添加组件" })
                ]
              })
            ]
          }),
          error !== null && jsx("div", { style: S.errorBox, children: error }),
          jsxs("div", {
            style: { ...S.row, justifyContent: "flex-end", paddingTop: 14, borderTop: `1px solid ${C.border}` },
            children: [
              savedAt !== null && jsx("span", { style: { color: C.success, fontSize: 12 }, children: "已保存" }),
              jsx(Button, { primary: true, onClick: save, disabled: busy, children: busy ? "保存中…" : "保存模板" })
            ]
          })
        ]
      });
    }

    // ------------------------------------------- branch types (collapsed)
    // 全局分支类型词汇表：创建功能工作区时「类型 + 主题 → 完整分支名」。
    // 首次读取时服务端会把内置项（Bugfix/功能/Hotfix/发布）落盘；这里整表编辑。
    function BranchTypesCard() {
      const [open, setOpen] = useState(false);
      return jsxs("div", {
        style: { ...S.card, display: "flex", flexDirection: "column", gap: open ? 12 : 0 },
        children: [
          jsxs("div", {
            style: { ...S.row, cursor: "pointer", userSelect: "none", justifyContent: "space-between" },
            onClick: () => setOpen(!open),
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: 8 },
                children: [
                  jsx("span", { style: { fontSize: 11, color: C.faint, width: 12 }, children: open ? "▾" : "▸" }),
                  jsx("span", { style: { fontSize: 13, fontWeight: 600 }, children: "分支类型" }),
                  jsx("span", { style: S.faint, children: "创建功能工作区时拼分支名的词汇表（内置 + 可自定义）" })
                ]
              }),
              jsx("span", { style: S.faint, children: open ? "收起" : "编辑" })
            ]
          }),
          open && jsx(BranchTypesForm, {})
        ]
      });
    }

    function BranchTypesForm() {
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [savedAt, setSavedAt] = useState(null);
      const [newLabel, setNewLabel] = useState("");
      const [newPrefix, setNewPrefix] = useState("");

      useEffect(() => {
        let cancelled = false;
        api("/branch-types")
          .then((data) => { if (!cancelled) setDraft(data.types); })
          .catch((cause) => { if (!cancelled) setError(cause.message); });
        return () => { cancelled = true; };
      }, []);

      const updateRow = (key, field, value) => setDraft((prev) => prev.map((row) => row.key === key ? { ...row, [field]: value } : row));
      const removeRow = (key) => setDraft((prev) => prev.filter((row) => row.key !== key));
      const addRow = () => {
        const label = newLabel.trim();
        if (label === "" || draft === null) return;
        const rawPrefix = newPrefix.trim().toLowerCase().replace(/\s+/g, "-").replace(/\/*$/u, "");
        const prefix = rawPrefix === "" ? "" : `${rawPrefix}/`;
        const baseKey = slugifyClient(prefix.replace(/\/+$/u, "")) || slugifyClient(label) || `type-${draft.length + 1}`;
        // 与服务端 normalizeBranchTypes 同款去重：key 撞名时追加 -x 直到唯一，
        // 否则 updateRow/removeRow 会同时命中多行（React 重复 key）。
        let key = baseKey;
        while (draft.some((row) => row.key === key)) key = `${baseKey}-x`;
        setDraft((prev) => [...prev, { key, label, prefix }]);
        setNewLabel("");
        setNewPrefix("");
      };
      const save = async () => {
        if (draft === null) return;
        setBusy(true); setError(null);
        try {
          const data = await api("/branch-types", { types: draft });
          setDraft(data.types);
          setSavedAt(new Date());
        } catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
      };

      if (draft === null) return jsx("div", { style: S.faint, children: error !== null ? error : "加载中…" });

      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: 8 },
        children: [
          ...draft.map((row) => jsxs("div", {
            style: { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) auto", gap: 8, alignItems: "center", border: `1px solid ${C.border}`, borderRadius: 8, background: C.bgRaised, padding: "6px 10px" },
            children: [
              jsx("input", { className: "wft-input", value: row.label, onChange: (e) => updateRow(row.key, "label", e.target.value), placeholder: "类型名，如 重构" }),
              jsx("input", { className: "wft-input", style: { fontFamily: C.mono, fontSize: 12 }, value: row.prefix, onChange: (e) => updateRow(row.key, "prefix", e.target.value), placeholder: "前缀，如 refactor/" }),
              jsx(Button, { danger: true, small: true, onClick: () => removeRow(row.key), children: "删除" })
            ]
          }, row.key)),
          jsxs("div", {
            style: { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) auto", gap: 8, alignItems: "center", border: `1px dashed ${C.border}`, borderRadius: 10, padding: 10 },
            children: [
              jsx("input", { className: "wft-input", value: newLabel, onChange: (e) => setNewLabel(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") addRow(); }, placeholder: "新类型名，如 重构" }),
              jsx("input", { className: "wft-input", style: { fontFamily: C.mono, fontSize: 12 }, value: newPrefix, onChange: (e) => setNewPrefix(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") addRow(); }, placeholder: "前缀，如 refactor/" }),
              jsx(Button, { onClick: addRow, disabled: newLabel.trim() === "", children: "+ 添加" })
            ]
          }),
          error !== null && jsx("div", { style: S.errorBox, children: error }),
          jsxs("div", {
            style: { ...S.row, justifyContent: "flex-end" },
            children: [
              savedAt !== null && jsx("span", { style: { color: C.success, fontSize: 12 }, children: "已保存" }),
              jsx(Button, { primary: true, onClick: save, disabled: busy, children: busy ? "保存中…" : "保存" })
            ]
          })
        ]
      });
    }

    // ------------------------------------------------------------- set editor
    // 套组编辑器：配置文件内容就是草稿（自包含、无合并、无约定推导——组件路径
    // 全部显式绑定）。选择目录时立即探测（git 仓库？基准分支？），非 git 目录
    // 给「初始化 git 仓库」出口。保存后行内验证；底部是基于已保存配置的预览。

    function slugifyClient(text) {
      return String(text).toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]+/g, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
    }

    function normalizeComponentClient(name) {
      return String(name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/g, "").replace(/-+$/g, "");
    }

    // One scalar row: just label + input; the placeholder shows the built-in
    // default, so an empty input reads as "用默认"。必填项缺失时行内提示。
    function ScalarRow(props) {
      const { label, effective, value, onChange, required, hint } = props;
      const missing = required === true && value.trim() === "" && effective === "";
      return jsxs("div", {
        style: { display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 10, alignItems: "center" },
        children: [
          jsx("span", { style: { fontSize: 12.5, fontWeight: 500, color: C.dim }, children: label }),
          jsxs("div", {
            style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
            children: [
              jsx("input", {
                className: "wft-input",
                value,
                onChange: (e) => onChange(e.target.value),
                placeholder: effective !== "" ? effective : required === true ? "（必填）" : ""
              }),
              missing && jsx("span", { style: { color: C.error, fontSize: 11.5 }, children: hint ?? "必填" })
            ]
          })
        ]
      });
    }

    // One component row: collapsed = one quiet line (name → path); expanded =
    // the editing area. Paths are explicit only; a picked non-repo directory
    // offers a git-init escape hatch.
    function ComponentRow(props) {
      const { name, entry, validation, basePlaceholder, probeIssue, probing, pickSupported, onPick, onInitGit, initBusy, onField, onRemove } = props;
      const [open, setOpen] = useState(false);
      const issues = validation?.issues ?? [];
      const pathValue = entry?.path ?? "";
      const label = entry?.label;
      return jsxs("div", {
        style: { border: `1px solid ${C.border}`, borderRadius: 10, background: C.bgRaised, padding: "8px 12px", display: "flex", flexDirection: "column" },
        children: [
          jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", minWidth: 0 },
            onClick: () => setOpen(!open),
            children: [
              jsx("span", { style: { fontSize: 11, color: C.faint, width: 12, flexShrink: 0 }, children: open ? "▾" : "▸" }),
              jsx("span", { style: { ...S.mono, fontWeight: 700, flexShrink: 0 }, children: name }),
              label !== undefined && label !== "" && jsx("span", { style: { ...S.faint, flexShrink: 0 }, children: label }),
              issues.length > 0 && jsx("span", { style: { color: C.error, fontSize: 12, flexShrink: 0 }, children: `✗ ${issues.length}` }),
              jsx("span", {
                style: { ...S.mono, fontSize: 12, color: pathValue === "" ? C.warn : C.dim, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" },
                title: pathValue,
                children: pathValue !== "" ? pathValue : "（未绑定，点开设置）"
              })
            ]
          }),
          open && jsxs("div", {
            style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 8 },
            children: [
              jsxs("div", {
                style: { display: "grid", gridTemplateColumns: "64px minmax(0,1fr) auto", gap: 8, alignItems: "center" },
                children: [
                  jsx("span", { style: { fontSize: 12, color: C.dim }, children: "仓库目录" }),
                  jsx("input", {
                    className: "wft-input",
                    style: { fontFamily: C.mono, fontSize: 12 },
                    value: pathValue,
                    onChange: (e) => onField("path", e.target.value),
                    placeholder: "选择或输入 git 仓库的绝对路径"
                  }),
                  jsx(Button, { small: true, disabled: !pickSupported || probing, onClick: onPick, children: probing ? "检查中…" : "选择…" })
                ]
              }),
              probeIssue === "not-git" && jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
                children: [
                  jsx("span", { style: { color: C.warn, fontSize: 12, flex: 1, minWidth: 200 }, children: "该目录不是 git 仓库，绑定后无法创建工作树。" }),
                  jsx(Button, { small: true, disabled: initBusy, onClick: onInitGit, children: initBusy ? "初始化中…" : "初始化 git 仓库" })
                ]
              }),
              probeIssue !== undefined && probeIssue !== "not-git" && jsx("div", { style: { color: C.error, fontSize: 12 }, children: probeIssue }),
              jsxs("div", {
                style: { display: "grid", gridTemplateColumns: "64px minmax(0,1fr)", gap: 8, alignItems: "center" },
                children: [
                  jsx("span", { style: { fontSize: 12, color: C.dim }, children: "显示名" }),
                  jsx("input", {
                    className: "wft-input",
                    value: entry?.label ?? "",
                    onChange: (e) => onField("label", e.target.value),
                    placeholder: "可选，如：后端"
                  })
                ]
              }),
              jsxs("div", {
                style: { display: "grid", gridTemplateColumns: "64px minmax(0,1fr)", gap: 8, alignItems: "center" },
                children: [
                  jsx("span", { style: { fontSize: 12, color: C.dim }, children: "基准分支" }),
                  jsx("input", {
                    className: "wft-input",
                    value: entry?.defaultBaseBranch ?? "",
                    onChange: (e) => onField("defaultBaseBranch", e.target.value),
                    placeholder: basePlaceholder !== "" ? `留空用默认：${basePlaceholder}` : "如 master / main"
                  })
                ]
              }),
              issues.length > 0 && jsx("div", {
                style: { display: "flex", flexDirection: "column", gap: 2 },
                children: issues.map((issue, index) => jsx("div", { style: { color: C.error, fontSize: 12 }, children: `✗ ${issue}` }, index))
              }),
              jsx("div", {
                style: { display: "flex", justifyContent: "flex-end" },
                children: jsx(Button, { small: true, danger: true, onClick: onRemove, title: "从仓库组中移除该组件", children: "删除组件" })
              })
            ]
          })
        ]
      });
    }

    // 「自动发现」弹窗：以一个参照目录为锚，扫描它旁边的 git 仓库批量绑定。
    // 没有任何组件绑定时先选参照目录。组件名可改、手动勾选（默认不勾），
    // 支持搜索和分页；勾选状态存在完整 rows 上，翻页/搜索不会丢。
    const DISCOVER_PAGE_SIZE = 8;
    function DiscoverReposModal(props) {
      const { referenceDir, pickDirectory, existingNames, onAdd, onClose } = props;
      const [ref, setRef] = useState(referenceDir ?? null);
      const [rows, setRows] = useState(null);
      const [error, setError] = useState(null);
      const [query, setQuery] = useState("");
      const [page, setPage] = useState(0);
      const [pickingRef, setPickingRef] = useState(false);

      useEffect(() => {
        if (ref === null) return undefined;
        let cancelled = false;
        setRows(null); setError(null);
        api("/scan-siblings", { cwd: ref })
          .then((data) => {
            if (cancelled) return;
            setRows((data.result.repos ?? []).map((repo) => ({
              path: repo.path,
              dirName: repo.name,
              component: normalizeComponentClient(repo.suggestedComponent ?? repo.name),
              included: false
            })));
          })
          .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
        return () => { cancelled = true; };
      }, [ref]);

      const pickRef = useCallback(async () => {
        if (typeof pickDirectory !== "function") return;
        setPickingRef(true);
        try {
          const picked = await pickDirectory();
          if (typeof picked === "string" && picked.trim() !== "") setRef(picked.trim());
        } finally {
          setPickingRef(false);
        }
      }, [pickDirectory]);

      const candidates = (rows ?? []).filter((row) => !existingNames.includes(row.component));
      const alreadyListed = (rows ?? []).length - candidates.length;
      const q = query.trim().toLowerCase();
      const filtered = q === "" ? candidates : candidates.filter((row) =>
        row.dirName.toLowerCase().includes(q) || row.component.toLowerCase().includes(q) || row.path.toLowerCase().includes(q));
      const pageCount = Math.max(1, Math.ceil(filtered.length / DISCOVER_PAGE_SIZE));
      const safePage = Math.min(page, pageCount - 1);
      const paged = filtered.slice(safePage * DISCOVER_PAGE_SIZE, (safePage + 1) * DISCOVER_PAGE_SIZE);
      const selected = (rows ?? []).filter((row) => row.included && row.component !== "" && !existingNames.includes(row.component));
      const updateRow = (path, patch) => setRows((prev) => (prev ?? []).map((row) => row.path === path ? { ...row, ...patch } : row));
      const confirm = () => { for (const row of selected) onAdd(row.component, row.path); onClose(); };

      return jsx("div", {
        style: S.modalMask,
        onClick: onClose,
        children: jsxs("div", {
          style: { ...S.modal, width: 560 },
          onClick: (e) => e.stopPropagation(),
          children: [
            jsx("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 }, children: "自动发现组件" }),
            ref === null
              ? jsxs("div", {
                  style: { display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" },
                  children: [
                    jsx("div", { style: S.faint, children: "先选一个参照目录——扫描它旁边的仓库。" }),
                    jsx(Button, { primary: true, disabled: pickingRef, onClick: pickRef, children: pickingRef ? "选择中…" : "选择参照目录…" })
                  ]
                })
              : jsxs(React.Fragment, {
                  children: [
                    jsxs("div", {
                      style: { ...S.faint, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 },
                      children: [
                        jsxs("span", {
                          style: { ...S.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                          title: ref,
                          children: ["扫描 ", ref, " 的相邻仓库"]
                        }),
                        jsx(Button, { small: true, disabled: pickingRef, onClick: pickRef, children: "换一个" })
                      ]
                    }),
                    rows !== null && candidates.length > 0 && jsx("input", {
                      className: "wft-input",
                      value: query,
                      onChange: (e) => { setQuery(e.target.value); setPage(0); },
                      placeholder: "搜索目录名 / 组件名 / 路径…",
                      style: { marginBottom: 10, width: "100%" }
                    }),
                    rows === null && error === null && jsx("div", { style: S.dim, children: "正在发现…" }),
                    error !== null && jsx("div", { style: S.errorBox, children: error }),
                    rows !== null && candidates.length === 0 && jsx("div", {
                      style: S.faint,
                      children: alreadyListed > 0 ? "相邻仓库都已在组件列表里。" : "没有发现相邻的 git 仓库。"
                    }),
                    rows !== null && candidates.length > 0 && filtered.length === 0 && jsx("div", { style: S.faint, children: `没有匹配「${query}」的仓库。` }),
                    jsx("div", {
                      style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 4 },
                      children: paged.map((row) => jsxs("div", {
                        style: { display: "grid", gridTemplateColumns: "auto 140px minmax(0,1fr)", gap: 10, alignItems: "center", padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.border}` },
                        children: [
                          jsx("input", {
                            type: "checkbox",
                            checked: row.included,
                            onChange: (e) => updateRow(row.path, { included: e.target.checked })
                          }),
                          jsx("input", {
                            className: "wft-input",
                            value: row.component,
                            onChange: (e) => updateRow(row.path, { component: normalizeComponentClient(e.target.value) }),
                            placeholder: "组件名"
                          }),
                          jsx("span", {
                            style: { ...S.mono, fontSize: 12, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                            title: row.path,
                            children: row.dirName
                          })
                        ]
                      }, row.path))
                    }),
                    jsxs("div", {
                      style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10 },
                      children: [
                        jsxs("div", {
                          style: { display: "flex", alignItems: "center", gap: 8 },
                          children: [
                            pageCount > 1 && jsxs(React.Fragment, {
                              children: [
                                jsx(Button, { small: true, disabled: safePage === 0, onClick: () => setPage(safePage - 1), children: "‹" }),
                                jsx("span", { style: S.faint, children: `${safePage + 1} / ${pageCount} 页 · 共 ${filtered.length} 个` }),
                                jsx(Button, { small: true, disabled: safePage >= pageCount - 1, onClick: () => setPage(safePage + 1), children: "›" })
                              ]
                            }),
                            alreadyListed > 0 && jsx("span", { style: S.faint, children: `${alreadyListed} 个已在列表中` })
                          ]
                        }),
                        jsxs("div", {
                          style: { display: "flex", gap: 8 },
                          children: [
                            jsx(Button, { onClick: onClose, children: "取消" }),
                            jsx(Button, { primary: true, disabled: selected.length === 0, onClick: confirm, children: `添加所选（${selected.length}）` })
                          ]
                        })
                      ]
                    })
                  ]
                }),
            ref === null && jsxs("div", {
              style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
              children: [jsx(Button, { onClick: onClose, children: "取消" })]
            })
          ]
        })
      });
    }

    // 新建套组弹窗：名字即身份（拼进功能工作区目录名，创建后不可改），
    // 初始内容来自「新套组模板」预填，创建后到编辑器里绑定组件。
    function NewSetModal(props) {
      const { existingNames, onCreated, onClose } = props;
      const [name, setName] = useState("");
      const [label, setLabel] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const normalized = normalizeComponentClient(name);
      const taken = normalized !== "" && existingNames.includes(normalized);
      const confirm = useCallback(async () => {
        if (normalized === "" || taken) return;
        setBusy(true); setError(null);
        try {
          const pre = await api("/detect");
          await api("/config", {
            set: normalized,
            config: { ...pre.config, label: label.trim() },
            revision: null
          });
          onCreated(normalized);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      }, [normalized, taken, label, onCreated]);

      return jsx("div", {
        style: S.modalMask,
        onClick: onClose,
        children: jsxs("div", {
          style: { ...S.modal, width: 440 },
          onClick: (e) => e.stopPropagation(),
          children: [
            jsx("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 }, children: "新建仓库组" }),
            jsx("div", { style: { ...S.faint, marginBottom: 14 }, children: "仓库组将多个仓库绑定为一个整体，在同一功能分支上协同开发。名称是唯一标识（小写字母/数字/连字符），会拼入功能工作区目录名，创建后不可修改。" }),
            jsxs("div", {
              style: { display: "flex", flexDirection: "column", gap: 10 },
              children: [
                jsxs("div", {
                  style: { display: "flex", flexDirection: "column", gap: 4 },
                  children: [
                    jsx("input", {
                      className: "wft-input",
                      value: name,
                      autoFocus: true,
                      onChange: (e) => setName(e.target.value),
                      onKeyDown: (e) => { if (e.key === "Enter") confirm(); },
                      placeholder: "名称，如 hd-platform"
                    }),
                    taken && jsx("span", { style: { color: C.error, fontSize: 11.5 }, children: "已存在同名仓库组" })
                  ]
                }),
                jsx("input", {
                  className: "wft-input",
                  value: label,
                  onChange: (e) => setLabel(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") confirm(); },
                  placeholder: "显示名（可选），如：HD 平台"
                }),
                error !== null && jsx("div", { style: S.errorBox, children: error })
              ]
            }),
            jsxs("div", {
              style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 },
              children: [
                jsx(Button, { onClick: onClose, children: "取消" }),
                jsx(Button, { primary: true, disabled: normalized === "" || taken || busy, onClick: confirm, children: busy ? "创建中…" : "创建" })
              ]
            })
          ]
        })
      });
    }

    function SetEditor(props) {
      const { set, onSaved, pickDirectory } = props;
      const pickSupported = typeof pickDirectory === "function";

      const [draft, setDraft] = useState(null);
      const [savedDraft, setSavedDraft] = useState(null);
      const [revision, setRevision] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [savedAt, setSavedAt] = useState(null);
      const [validation, setValidation] = useState(null);
      const [discoverOpen, setDiscoverOpen] = useState(false);
      const [bindingRepo, setBindingRepo] = useState(null);
      const [probeIssues, setProbeIssues] = useState({});
      const [initBusyRepo, setInitBusyRepo] = useState(null);
      const [newRepoName, setNewRepoName] = useState("");

      // Load the set config; the file content IS the draft.
      useEffect(() => {
        let cancelled = false;
        setDraft(null); setSavedDraft(null); setRevision(null); setValidation(null); setError(null);
        setProbeIssues({});
        api(`/config?set=${encodeURIComponent(set)}`)
          .then((data) => {
            if (cancelled) return;
            const layer = {
              label: data.config.label ?? "",
              worktreeRoot: data.config.worktreeRoot ?? "",
              defaultBaseBranch: data.config.defaultBaseBranch ?? "",
              sharedDocsPath: data.config.sharedDocsPath ?? "",
              projectInstructions: data.config.projectInstructions ?? "",
              repositories: data.config.repositories ?? {}
            };
            setDraft(layer);
            setSavedDraft(layer);
            setRevision(data.revision);
          })
          .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
        return () => { cancelled = true; };
      }, [set]);

      // Inline validation of the SAVED config; re-runs after saves.
      useEffect(() => {
        if (savedDraft === null) return undefined;
        let cancelled = false;
        api("/validate", { set })
          .then((data) => { if (!cancelled) setValidation(data.result); })
          .catch(() => { if (!cancelled) setValidation(null); });
        return () => { cancelled = true; };
      }, [set, savedDraft]);

      const dirty = useMemo(() => draft !== null && savedDraft !== null && JSON.stringify(draft) !== JSON.stringify(savedDraft), [draft, savedDraft]);

      const update = useCallback((field, value) => setDraft((prev) => ({ ...prev, [field]: value })), []);
      const updateRepo = useCallback((name, field, value) => {
        setDraft((prev) => {
          const entry = { ...(prev.repositories[name] ?? {}) };
          if (typeof value === "string" && value.trim() === "") delete entry[field];
          else entry[field] = value;
          return { ...prev, repositories: { ...prev.repositories, [name]: entry } };
        });
      }, []);
      const removeRepo = useCallback((name) => {
        setDraft((prev) => {
          const repositories = { ...prev.repositories };
          delete repositories[name];
          return { ...prev, repositories };
        });
      }, []);
      const addRepo = useCallback((name, repoPath) => {
        const normalized = normalizeComponentClient(name);
        if (normalized === "") return;
        setDraft((prev) => prev.repositories[normalized] !== undefined ? prev : ({
          ...prev,
          repositories: { ...prev.repositories, [normalized]: repoPath !== undefined ? { path: repoPath } : {} }
        }));
      }, []);

      // 选择目录后立即探测：是 git 仓库就绑定探测到的主克隆根；不是就绑定原
      // 样路径并标记 not-git（行内给「初始化 git 仓库」出口）。
      const probeAndBind = useCallback(async (name, dir) => {
        try {
          const data = await api("/probe", { path: dir });
          updateRepo(name, "path", data.result.path);
          setProbeIssues((prev) => {
            const next = { ...prev };
            if (data.result.isRepo === true) delete next[name];
            else next[name] = "not-git";
            return next;
          });
        } catch (cause) {
          updateRepo(name, "path", dir);
          setProbeIssues((prev) => ({ ...prev, [name]: cause instanceof Error ? cause.message : String(cause) }));
        }
      }, [updateRepo]);

      const pickRepo = useCallback(async (name) => {
        if (!pickSupported) { setError("当前环境不支持目录选择器。"); return; }
        setBindingRepo(name); setError(null);
        try {
          const picked = await pickDirectory();
          if (typeof picked === "string" && picked.trim() !== "") await probeAndBind(name, picked.trim());
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBindingRepo(null);
        }
      }, [pickSupported, pickDirectory, probeAndBind]);

      const pickSharedDocs = useCallback(async () => {
        if (!pickSupported) { setError("当前环境不支持目录选择器。"); return; }
        setError(null);
        try {
          const picked = await pickDirectory();
          if (typeof picked === "string" && picked.trim() !== "") update("sharedDocsPath", picked.trim());
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [pickSupported, pickDirectory, update]);

      const initGitRepo = useCallback(async (name) => {
        const dir = draft?.repositories?.[name]?.path;
        if (typeof dir !== "string" || dir === "") return;
        setInitBusyRepo(name);
        try {
          await api("/git-init", { cwd: dir });
          await probeAndBind(name, dir);
        } catch (cause) {
          setProbeIssues((prev) => ({ ...prev, [name]: cause instanceof Error ? cause.message : String(cause) }));
        } finally {
          setInitBusyRepo(null);
        }
      }, [draft, probeAndBind]);

      const save = useCallback(async () => {
        if (draft === null) return;
        setBusy(true); setError(null);
        try {
          const saved = await api("/config", { set, config: draft, revision });
          setSavedDraft(draft);
          setRevision(saved.revision);
          setSavedAt(new Date());
          onSaved();
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
      }, [draft, set, revision, onSaved]);
      const discard = useCallback(() => { setDraft(savedDraft); setError(null); }, [savedDraft]);

      if (draft === null) {
        return jsx("div", { style: S.card, children: error !== null ? error : "加载中…" });
      }

      const names = Object.keys(draft.repositories ?? {});
      const validationByName = new Map((validation?.components ?? []).map((row) => [row.name, row]));
      const firstBoundPath = names.map((name) => draft.repositories[name]?.path).find((p) => typeof p === "string" && p !== "");

      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: 12 },
        children: [
          error !== null && jsx("div", { style: S.errorBox, children: error }),

          jsxs("div", {
            style: { ...S.card, display: "flex", flexDirection: "column", gap: 10 },
            children: [
              jsx("div", { style: { fontSize: 12, fontWeight: 500, color: C.dim }, children: "基础设置" }),
              jsx(ScalarRow, { label: "工作区根目录", effective: "", value: draft.worktreeRoot ?? "", onChange: (v) => update("worktreeRoot", v), required: true, hint: "必填：功能工作区的根目录" }),
              jsx(ScalarRow, { label: "默认基准分支", effective: "master", value: draft.defaultBaseBranch ?? "", onChange: (v) => update("defaultBaseBranch", v) }),
              jsx(ScalarRow, { label: "显示名", effective: "", value: draft.label ?? "", onChange: (v) => update("label", v) }),
              jsxs("div", {
                style: { display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 10, alignItems: "start" },
                children: [
                  jsx("span", { style: { fontSize: 12.5, fontWeight: 500, color: C.dim, paddingTop: 8 }, children: "共享 docs 源目录" }),
                  jsxs("div", {
                    style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
                    children: [
                      jsxs("div", {
                        style: { display: "flex", gap: 8 },
                        children: [
                          jsx("input", {
                            className: "wft-input",
                            style: { flex: 1, fontFamily: C.mono, fontSize: 12 },
                            value: draft.sharedDocsPath ?? "",
                            onChange: (e) => update("sharedDocsPath", e.target.value),
                            placeholder: "可选，如 D:\\workspace\\project\\docs"
                          }),
                          jsx(Button, { small: true, disabled: !pickSupported, onClick: pickSharedDocs, children: "选择…" })
                        ]
                      }),
                      jsx("span", { style: S.faint, children: "可选：所有功能区直接读取同一原始目录；会话通过受限 docs 工具修改，不再复制快照。" })
                    ]
                  })
                ]
              }),
              jsxs("div", {
                style: { display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 10, alignItems: "start" },
                children: [
                  jsx("span", { style: { fontSize: 12.5, fontWeight: 500, color: C.dim, paddingTop: 8 }, children: "项目会话说明" }),
                  jsxs("div", {
                    style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
                    children: [
                      jsx("textarea", {
                        className: "wft-input",
                        style: { minHeight: 92, resize: "vertical", lineHeight: 1.55 },
                        value: draft.projectInstructions ?? "",
                        onChange: (e) => update("projectInstructions", e.target.value),
                        placeholder: "可选，例如项目通用 SQL 规范、目录约定或联调注意事项"
                      }),
                      jsx("span", { style: S.faint, children: "保存后，每个功能区的新会话都会读取最新项目说明，并与创建功能区时填写的功能区说明一起注入。" })
                    ]
                  })
                ]
              })
            ]
          }),

          jsxs("div", {
            style: { ...S.card, display: "flex", flexDirection: "column", gap: 10 },
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
                children: [
                  jsxs("div", {
                    style: { display: "flex", alignItems: "center", gap: 8 },
                    children: [
                      jsx("div", { style: { fontSize: 12, fontWeight: 500, color: C.dim }, children: "组件仓库" }),
                      jsx(Pill, { children: `${names.length} 个组件` })
                    ]
                  }),
                  jsx(Button, { small: true, onClick: () => setDiscoverOpen(true), title: "以一个目录为锚，扫描它旁边的 git 仓库批量绑定为组件", children: "自动发现" })
                ]
              }),
              names.length === 0 && jsx("div", { style: S.faint, children: "还没有组件。手动添加组件名，或点「自动发现」批量导入。" }),
              ...names.map((name) => jsx(ComponentRow, {
                name,
                entry: draft.repositories?.[name],
                validation: validationByName.get(name),
                basePlaceholder: (draft.defaultBaseBranch ?? "").trim() !== "" ? draft.defaultBaseBranch : "master",
                probeIssue: probeIssues[name],
                probing: bindingRepo === name,
                pickSupported,
                onPick: () => pickRepo(name),
                onInitGit: () => initGitRepo(name),
                initBusy: initBusyRepo === name,
                onField: (field, value) => updateRepo(name, field, value),
                onRemove: () => removeRepo(name)
              }, name)),
              jsxs("div", {
                style: { display: "flex", gap: 8, alignItems: "center" },
                children: [
                  jsx("input", {
                    value: newRepoName,
                    onChange: (e) => setNewRepoName(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") { addRepo(newRepoName); setNewRepoName(""); } },
                    placeholder: "新组件名，如 frontend",
                    style: { ...S.input, flex: 1 }
                  }),
                  jsx(Button, { onClick: () => { addRepo(newRepoName); setNewRepoName(""); }, disabled: normalizeComponentClient(newRepoName) === "", children: "+ 添加组件" })
                ]
              })
            ]
          }),

          validation !== null && !validation.ok && jsxs("div", {
            style: { ...S.card, display: "flex", flexDirection: "column", gap: 6, borderColor: C.error },
            children: [
              jsx("div", { style: { fontSize: 12.5, fontWeight: 600, color: C.error }, children: "✗ 配置存在问题（详见上方组件行内标注）" }),
              validation.worktreeRoot?.note !== undefined && jsx("div", { style: S.faint, children: `工作区根目录：${validation.worktreeRoot.note}` }),
              validation.sharedDocs?.note !== undefined && jsx("div", { style: { ...S.faint, color: C.error }, children: `共享 docs：${validation.sharedDocs.note}` }),
              ...(validation.problems ?? []).map((problem, index) => jsx("div", { style: { color: C.error, fontSize: 12 }, children: `✗ ${problem}` }, index))
            ]
          }),

          jsxs("div", {
            style: { ...S.row, justifyContent: "flex-end" },
            children: [
              savedAt !== null && !dirty && jsx("span", { style: { color: C.success, fontSize: 12 }, children: "已保存" }),
              dirty && jsx(Button, { onClick: discard, disabled: busy, children: "放弃更改" }),
              jsx(Button, { primary: true, onClick: save, disabled: busy || !dirty, children: busy ? "保存中…" : "保存配置" })
            ]
          }),

          discoverOpen && jsx(DiscoverReposModal, {
            referenceDir: firstBoundPath,
            pickDirectory,
            existingNames: names,
            onAdd: addRepo,
            onClose: () => setDiscoverOpen(false)
          })
        ]
      });
    }

    // 自制套组下拉：与输入控件同一视觉语言。按钮态显示「名称 + 显示名」，
    // 弹出列表每项一行（选中 ✓ / 名称加粗 / 显示名与组件数弱化）。
    function SetPicker(props) {
      const { sets, value, onSelect, emptyLabel } = props;
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        const onDocDown = (e) => { if (rootRef.current !== null && !rootRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDocDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDocDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      const list = sets ?? [];
      const active = list.find((entry) => entry.name === value);
      const choose = (name) => { setOpen(false); onSelect(name); };

      return jsxs("div", {
        style: { display: "flex", alignItems: "center", gap: 10 },
        children: [
          jsx("span", { style: { fontSize: 12, fontWeight: 500, color: C.dim, flexShrink: 0 }, children: "仓库组" }),
          jsxs("div", {
            className: "wft-picker",
            ref: rootRef,
            children: [
              jsxs("button", {
                type: "button",
                className: "wft-picker-btn",
                "data-open": String(open),
                onClick: () => setOpen(!open),
                children: [
                  active === undefined
                    ? jsx("span", { style: { color: C.faint }, children: emptyLabel })
                    : jsxs(React.Fragment, {
                        children: [
                          jsx("span", { style: { ...S.mono, fontWeight: 600, flexShrink: 0 }, children: active.name }),
                          active.label !== undefined && active.label !== "" && jsx("span", { style: { color: C.dim, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: active.label })
                        ]
                      }),
                  jsx("span", { className: "wft-chevron", children: "▾" })
                ]
              }),
              open && jsx("div", {
                className: "wft-picker-menu",
                children: list.length === 0
                  ? jsx("div", { style: { color: C.faint, fontSize: 12, padding: "8px 10px" }, children: emptyLabel })
                  : list.map((entry) => jsxs("button", {
                      type: "button",
                      className: "wft-picker-item",
                      onClick: () => choose(entry.name),
                      children: [
                        jsx("span", { style: { width: 14, flexShrink: 0, color: C.brandText, fontSize: 12 }, children: entry.name === value ? "✓" : "" }),
                        jsx("span", { style: { ...S.mono, fontWeight: 600, flexShrink: 0 }, children: entry.name }),
                        entry.label !== undefined && entry.label !== "" && jsx("span", { style: { color: C.dim, flexShrink: 0 }, children: entry.label }),
                        jsx("span", { style: { color: C.faint, fontSize: 12, marginLeft: "auto", flexShrink: 0 }, children: `${entry.componentCount} 组件` })
                      ]
                    }, entry.name))
              })
            ]
          })
        ]
      });
    }

    // ------------------------------------------------------------ section
    function WorktreeFlowSection(props) {
      const [tab, setTab] = useState("config");
      const [sets, setSets] = useState(null);
      const [current, setCurrent] = useState(() => {
        try { return localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
      });
      const [newSetOpen, setNewSetOpen] = useState(false);
      const [features, setFeatures] = useState(null);
      const [error, setError] = useState(null);
      const [cleanupTarget, setCleanupTarget] = useState(null);
      const [refreshTick, setRefreshTick] = useState(0);

      // list sets (re-runs after saves/creates)
      useEffect(() => {
        let cancelled = false;
        api("/sets")
          .then((data) => { if (!cancelled) setSets(data.sets); })
          .catch(() => { if (!cancelled) setSets([]); });
        return () => { cancelled = true; };
      }, [refreshTick]);

      // default selection: stored when still valid, else the first set
      useEffect(() => {
        if (!Array.isArray(sets)) return;
        if (current !== "" && !sets.some((entry) => entry.name === current)) setCurrent("");
        else if (current === "" && sets.length > 0) setCurrent(sets[0].name);
      }, [sets, current]);

      // features for the active set
      useEffect(() => {
        if (tab !== "features" || current === "") { setFeatures(null); return; }
        let cancelled = false;
        api(`/features?set=${encodeURIComponent(current)}`)
          .then((data) => {
            if (cancelled) return;
            setFeatures(data.features);
            if (Array.isArray(data.manifestErrors) && data.manifestErrors.length > 0) {
              setError(`有 ${data.manifestErrors.length} 个功能清单无效，已隔离；运行 /worktree sync 查看详情。`);
            }
          })
          .catch((cause) => { if (!cancelled) { setError(cause.message); setFeatures(null); } });
        return () => { cancelled = true; };
      }, [tab, current, refreshTick]);

      const selectSet = useCallback((value) => {
        setCurrent(value);
        try { localStorage.setItem(STORAGE_KEY, value); } catch { /* ignore */ }
      }, []);
      const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);
      const afterAction = useCallback((message) => {
        if (typeof message === "string") setError(message);
        refresh();
      }, [refresh]);

      const picker = jsx(SetPicker, {
        sets: sets ?? [],
        value: current,
        onSelect: selectSet,
        emptyLabel: sets === null ? "加载中…" : "选择或新建仓库组"
      });

      return jsxs("div", {
        style: S.page,
        children: [
          jsxs("div", {
            className: "wft-tabbar",
            children: [
              jsx("button", { type: "button", className: "wft-tab", "data-active": String(tab === "config"), onClick: () => setTab("config"), children: "配置" }),
              jsx("button", { type: "button", className: "wft-tab", "data-active": String(tab === "features"), onClick: () => setTab("features"), children: "功能工作区" })
            ]
          }),

          error !== null && jsx("div", { style: S.errorBox, children: error }),

          tab === "config" && jsxs(React.Fragment, {
            children: [
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
                children: [
                  jsx("div", { style: { fontSize: 16, fontWeight: 600 }, children: "仓库组配置" }),
                  jsx(Button, { primary: true, onClick: () => setNewSetOpen(true), children: "+ 新建仓库组" })
                ]
              }),
              picker,
              current === ""
                ? jsx("div", { style: S.card, children: "还没有仓库组。仓库组将多个仓库绑定为一个整体，在同一功能分支上协同开发。点击右上角「+ 新建仓库组」创建。" })
                : jsx(SetEditor, { set: current, onSaved: refresh, pickDirectory: props.pickProjectDirectory }, current),
              jsx(TemplateCard, {}),
              jsx(BranchTypesCard, {})
            ]
          }),

          tab === "features" && picker,
          tab === "features" && (current === ""
            ? jsx("div", { style: S.card, children: "还没有选中的仓库组，请先到「配置」页新建。" })
            : features === null
              ? jsx("div", { style: S.dim, children: "加载中…" })
              : features.length === 0
                ? jsx("div", { style: S.card, children: "还没有功能工作区。侧边栏「新建工作区」选「功能工作区」，或 /worktree create。" })
                : features.map((feature) => jsx(FeatureCard, {
                    feature,
                    set: current,
                    onAction: afterAction,
                    onCleanup: () => setCleanupTarget(feature)
                  }, feature.feature))),

          cleanupTarget !== null && jsx(CleanupModal, {
            feature: cleanupTarget,
            set: current,
            onClose: () => setCleanupTarget(null),
            onDone: () => { setCleanupTarget(null); refresh(); }
          }),
          newSetOpen && jsx(NewSetModal, {
            existingNames: (sets ?? []).map((entry) => entry.name),
            onCreated: (name) => { setNewSetOpen(false); selectSet(name); refresh(); },
            onClose: () => setNewSetOpen(false)
          })
        ]
      });
    }

    // ------------------------------------------- add-workspace flow takeover
    // 注册进 directoryFlow 槽并用 priority:-1 压过原生/浏览目录选择器（single 槽
    // 取 priority 最低者）。弹出二选一：普通工作区仍走原生目录选择（pick），功能
    // 工作区走 Worktree Flow 创建向导。
    function WorktreeDirectoryFlow(props) {
      const { open, onPicked, onCancel, onError, pick } = props;
      const [view, setView] = useState("choose");
      const [sets, setSets] = useState([]);
      const [currentSet, setCurrentSet] = useState("");
      const [config, setConfig] = useState(null);
      const [featureBusy, setFeatureBusy] = useState(false);
      const [featureError, setFeatureError] = useState(null);

      useEffect(() => {
        if (open) { setView("choose"); setSets([]); setCurrentSet(""); setConfig(null); setFeatureBusy(false); setFeatureError(null); }
      }, [open]);

      const pickNormal = useCallback(() => {
        if (typeof pick !== "function") { onCancel(); return; }
        pick().then((path) => {
          if (path === null || path === undefined || path === "") onCancel();
          else onPicked(path);
        }, (reason) => onError(reason instanceof Error ? reason.message : String(reason)));
      }, [pick, onPicked, onCancel, onError]);

      const openFeature = useCallback(async () => {
        setView("feature"); setSets([]); setCurrentSet(""); setConfig(null); setFeatureBusy(true); setFeatureError(null);
        try {
          const data = await api("/sets");
          const rows = Array.isArray(data.sets) ? data.sets : [];
          let preferred = "";
          try { preferred = localStorage.getItem(STORAGE_KEY) ?? ""; } catch { /* ignore */ }
          // 没配置完的（缺工作区根目录/组件未绑定）不参与创建：禁选且不自动选中。
          const usable = rows.filter((row) => row.ready === true);
          if (!usable.some((row) => row.name === preferred)) preferred = usable[0]?.name ?? "";
          setSets(rows);
          setCurrentSet(preferred);
          if (preferred === "") {
            setFeatureError(rows.length === 0
              ? "还没有仓库组——先到 Settings → Worktree Flow 新建。"
              : "仓库组都还没配置完（工作区根目录 + 组件目录）——先到「配置」页完成绑定。");
          }
        } catch (cause) {
          setFeatureError(cause instanceof Error ? cause.message : String(cause));
        } finally { setFeatureBusy(false); }
      }, []);

      const loadSet = useCallback(async () => {
        if (currentSet === "") return;
        setFeatureBusy(true); setFeatureError(null); setConfig(null);
        try {
          const cfg = await api(`/config?set=${encodeURIComponent(currentSet)}`);
          try { localStorage.setItem(STORAGE_KEY, currentSet); } catch { /* ignore */ }
          setConfig(cfg.config);
        } catch (cause) {
          setFeatureError(cause instanceof Error ? cause.message : String(cause));
        } finally { setFeatureBusy(false); }
      }, [currentSet]);

      const onFeatureCreated = useCallback((result) => {
        if (result && result.featureRoot) onPicked(result.featureRoot);
        else onCancel();
      }, [onPicked, onCancel]);

      if (!open) return null;

      // 未完成配置的仓库组不参与创建：直接不列出。
      const usableSets = sets.filter((row) => row.ready === true);

      if (view === "feature") {
        if (config !== null && !featureBusy) {
          return jsx(CreateWizard, { set: currentSet, config, onClose: onCancel, onCreated: onFeatureCreated });
        }
        return jsx("div", {
          style: S.modalMask,
          children: jsxs("div", {
            style: { ...S.modal, width: 460 },
            children: [
              jsx("div", { style: { fontSize: 15, fontWeight: 600, paddingBottom: 12, marginBottom: 14, borderBottom: `1px solid ${C.border}` }, children: "选择功能工作区所属仓库组" }),
              featureBusy && jsx("div", { style: S.dim, children: "正在读取仓库组…" }),
              !featureBusy && usableSets.length > 0 && jsxs("div", {
                style: { display: "flex", flexDirection: "column", gap: 8 },
                children: [
                  jsx("span", { style: { fontSize: 12, color: C.dim }, children: "目标仓库组" }),
                  jsx(MiniPicker, {
                    value: currentSet,
                    placeholder: "选择仓库组",
                    onChange: (value) => { setCurrentSet(value); setConfig(null); setFeatureError(null); },
                    options: usableSets.map((row) => ({
                      value: row.name,
                      label: row.name,
                      mono: true,
                      hint: row.label ?? ""
                    }))
                  })
                ]
              }),
              featureError !== null && jsx("div", { style: { ...S.errorBox, marginTop: 8 }, children: featureError }),
              jsxs("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }, children: [
                jsx(Button, { onClick: () => { setView("choose"); setFeatureError(null); }, children: "返回" }),
                jsx(Button, { onClick: onCancel, children: "取消" }),
                jsx(Button, { primary: true, onClick: loadSet, disabled: featureBusy || currentSet === "", children: featureBusy ? "读取中…" : "继续" })
              ] })
            ]
          })
        });
      }

      const choiceStyle = {
        width: "100%", textAlign: "left", padding: "12px 14px", borderRadius: 8,
        border: `1px solid ${C.border}`, background: C.bgRaised, color: C.text,
        fontSize: 13, cursor: "pointer", fontFamily: "inherit"
      };
      return jsx("div", {
        style: S.modalMask,
        children: jsxs("div", {
          style: { ...S.modal, width: 420 },
          children: [
            jsx("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 12 }, children: "新增工作区" }),
            jsxs("div", {
              style: { display: "flex", flexDirection: "column", gap: 10 },
              children: [
                jsx("button", { type: "button", onClick: pickNormal, style: choiceStyle, children: jsxs(React.Fragment, { children: [
                  jsx("div", { style: { fontWeight: 500 }, children: "普通工作区" }),
                  jsx("div", { style: { ...S.faint, marginTop: 2 }, children: "选择一个已有目录作为工作区" })
                ] }) }),
                jsx("button", { type: "button", onClick: openFeature, style: choiceStyle, children: jsxs(React.Fragment, { children: [
                  jsx("div", { style: { fontWeight: 500 }, children: "功能工作区" }),
                  jsx("div", { style: { ...S.faint, marginTop: 2 }, children: "用 Worktree Flow 创建多仓库功能工作树" })
                ] }) })
              ]
            }),
            jsxs("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 12 }, children: [
              jsx(Button, { onClick: onCancel, children: "取消" })
            ] })
          ]
        })
      });
    }

    // ------------------------------------------- session awareness (chat page)
    // 会话页的两个增量座位：标题旁徽章（常显锚点，conversation.session.header.
    // actions）+ composer 上方按需横幅（conversation.input.dock，默认安静、出
    // 问题才出现）。数据都来自 GET /worktree-flow/locate?cwd=——cwd 取自会话
    // 列表快照（byId[sessionId].cwd）。
    // 两阶段定位：默认快速版（manifest + 目录存在性，徽章毫秒级出现）；
    // detail=true 才带每组件的 git 状态（慢，浮层/告警条用）。模块级缓存
    // 30s + 在途去重：切会话来回时徽章不闪。
    const LOCATE_TTL_MS = 30_000;
    const locateCache = new Map();
    const locateInflight = new Map();
    let clientCacheEpoch = 0;
    function invalidateClientCaches() {
      clientCacheEpoch += 1;
      locateCache.clear();
      locateInflight.clear();
      setsPromise = null;
      setsPromiseAt = 0;
    }
    function fetchLocate(cwd, detail, force) {
      const epoch = clientCacheEpoch;
      const key = `${detail === true ? "d" : "f"}:${cwd}`;
      const inflightKey = `${epoch}:${key}`;
      if (force === true) locateCache.delete(key);
      const hit = locateCache.get(key);
      if (hit !== undefined && hit.epoch === epoch && Date.now() - hit.at < LOCATE_TTL_MS) return Promise.resolve(hit.data);
      let pending = locateInflight.get(inflightKey);
      if (pending === undefined) {
        pending = api(`/locate?cwd=${encodeURIComponent(cwd)}${detail === true ? "&detail=1" : ""}`)
          .then((data) => {
            if (clientCacheEpoch === epoch) {
              locateCache.set(key, { at: Date.now(), data, epoch });
              while (locateCache.size > 128) locateCache.delete(locateCache.keys().next().value);
            }
            locateInflight.delete(inflightKey);
            return data;
          })
          .catch((error) => { locateInflight.delete(inflightKey); throw error; });
        locateInflight.set(inflightKey, pending);
      }
      return pending;
    }

    // 仓库组列表常驻缓存（首次页面加载后同步可用）；只用于乐观预渲染。
    let setsPromise = null;
    let setsPromiseAt = 0;
    function fetchSets() {
      if (setsPromise === null || Date.now() - setsPromiseAt >= 30_000) {
        const epoch = clientCacheEpoch;
        setsPromiseAt = Date.now();
        setsPromise = api("/sets")
          .then((data) => (Array.isArray(data.sets) ? data.sets : []))
          .catch(() => {
            if (clientCacheEpoch === epoch) { setsPromise = null; setsPromiseAt = 0; }
            return [];
          });
      }
      return setsPromise;
    }

    // 纯路径推导：cwd 是否落在某个仓库组的 <worktreeRoot>/<set>/<feature>
    // 之下。Windows 路径统一成小写反斜杠比较；命中即返回临时 loc（无
    // manifest 详情，徽章先行，权威 /locate 随后覆盖）。
    function provisionalLocate(cwd, sets) {
      const norm = (value) => value.replace(/\//gu, "\\").replace(/\\+$/u, "").toLowerCase();
      const target = norm(cwd);
      for (const set of sets) {
        if (typeof set.worktreeRoot !== "string" || set.worktreeRoot === "") continue;
        const prefix = `${norm(set.worktreeRoot)}\\${set.name}\\`;
        if (!target.startsWith(prefix)) continue;
        const feature = target.slice(prefix.length).split("\\")[0];
        if (feature === "") continue;
        return { found: true, provisional: true, set: set.name, feature: { feature, root: `${prefix}${feature}`, components: {} } };
      }
      return null;
    }

    function useFeatureLocation(kit, detail) {
      const cwd = kit.useSessions((state) => state.byId[kit.sessionId]?.cwd);
      const [loc, setLoc] = useState(null);
      const [tick, setTick] = useState(0);
      useEffect(() => {
        if (typeof cwd !== "string" || cwd === "") { setLoc(null); return undefined; }
        let cancelled = false;
        let settled = false;
        // 乐观先行：按路径约定 <worktreeRoot>/<set>/<feature> 从 cwd 直接
        // 推出徽章（仓库组列表常驻缓存，二次导航零等待）；/locate 权威结果
        // 回来后覆盖或撤掉。
        fetchSets().then((sets) => {
          if (cancelled || settled) return;
          const provisional = provisionalLocate(cwd, sets);
          if (provisional !== null) setLoc(provisional);
        });
        fetchLocate(cwd, detail === true, tick > 0)
          .then((data) => { settled = true; if (!cancelled) setLoc(data.found === true ? data : null); })
          .catch(() => { if (!cancelled && !settled) setLoc(null); });
        return () => { cancelled = true; };
      }, [cwd, detail, tick]);
      return { loc, cwd, refresh: () => setTick((n) => n + 1) };
    }

    function featureAlerts(loc) {
      if (loc === null) return [];
      const feature = loc.feature;
      const comps = Object.values(feature.components ?? {});
      const alerts = [];
      if (feature.archived === true || feature.status === "archived") {
        alerts.push({ level: "warn", text: "该功能工作区已归档——目录仍在，确认是有意在此继续。" });
      }
      const missing = comps.filter((row) => row.git?.present !== true && row.state !== "failed");
      if (missing.length > 0) alerts.push({ level: "error", text: `组件目录缺失：${missing.map((row) => row.name).join("、")}` });
      const mismatch = comps.filter((row) => row.git?.branchMismatch === true);
      if (mismatch.length > 0) alerts.push({ level: "error", text: `组件不在功能分支上：${mismatch.map((row) => row.name).join("、")}` });
      const unknown = comps.filter((row) => row.git?.readError !== undefined);
      if (unknown.length > 0) alerts.push({ level: "error", text: `组件 Git 状态无法确认：${unknown.map((row) => row.name).join("、")}` });
      return alerts;
    }

    // 标题旁徽章：cwd 落在功能工作区才出现；点开浮层看分支与组件健康度。
    // 徽章用快速定位（立即出现），浮层打开时才拉 git 详情。
    function FeatureBadgeAction(kit) {
      const { loc, cwd } = useFeatureLocation(kit, false);
      const [open, setOpen] = useState(false);
      const [detail, setDetail] = useState(null);
      const [instructionContext, setInstructionContext] = useState(null);
      const [instructions, setInstructions] = useState("");
      const [savedInstructions, setSavedInstructions] = useState("");
      const [instructionsBusy, setInstructionsBusy] = useState(false);
      const [instructionsError, setInstructionsError] = useState(null);
      const rootRef = useRef(null);
      const triggerRef = useRef(null);
      const detailRequest = useRef(0);
      const instructionRequest = useRef(0);
      const loadDetail = useCallback(() => {
        if (typeof cwd !== "string" || cwd === "") return;
        const request = detailRequest.current + 1;
        detailRequest.current = request;
        fetchLocate(cwd, true, true)
          .then((data) => { if (detailRequest.current === request) setDetail(data.found === true ? data : null); })
          .catch(() => { /* 保留旧详情 */ });
      }, [cwd]);
      const loadInstructions = useCallback(() => {
        if (loc === null) return;
        const request = instructionRequest.current + 1;
        instructionRequest.current = request;
        const set = loc.set;
        const feature = loc.feature.feature;
        setInstructionsBusy(true); setInstructionsError(null);
        Promise.all([
          api(`/config?set=${encodeURIComponent(set)}`),
          api(`/feature-instructions?set=${encodeURIComponent(set)}&feature=${encodeURIComponent(feature)}`)
        ])
          .then(([configData, featureData]) => {
            if (instructionRequest.current !== request) return;
            const value = featureData.result?.sessionInstructions ?? "";
            setInstructionContext({ projectInstructions: configData.config?.projectInstructions ?? "" });
            setInstructions(value); setSavedInstructions(value);
          })
          .catch((cause) => {
            if (instructionRequest.current === request) setInstructionsError(cause instanceof Error ? cause.message : String(cause));
          })
          .finally(() => { if (instructionRequest.current === request) setInstructionsBusy(false); });
      }, [loc?.set, loc?.feature?.feature]);
      const saveInstructions = useCallback(async () => {
        if (loc === null) return;
        setInstructionsBusy(true); setInstructionsError(null);
        try {
          const result = await api("/feature-instructions", {
            set: loc.set,
            feature: loc.feature.feature,
            sessionInstructions: instructions
          });
          const value = result.result?.sessionInstructions ?? "";
          setInstructions(value); setSavedInstructions(value);
        } catch (cause) {
          setInstructionsError(cause instanceof Error ? cause.message : String(cause));
        } finally { setInstructionsBusy(false); }
      }, [loc?.set, loc?.feature?.feature, instructions]);
      useEffect(() => {
        detailRequest.current += 1;
        instructionRequest.current += 1;
        setDetail(null); setInstructionContext(null); setInstructions(""); setSavedInstructions(""); setInstructionsError(null);
      }, [cwd]);
      useEffect(() => {
        if (!open) return undefined;
        const onDocDown = (e) => { if (rootRef.current !== null && !rootRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        // fixed 弹层坐标只在打开时快照一次；视口滚动/缩放后直接关闭，避免错位残留。
        const onShift = () => setOpen(false);
        document.addEventListener("mousedown", onDocDown);
        document.addEventListener("keydown", onKey);
        window.addEventListener("resize", onShift);
        window.addEventListener("scroll", onShift, true);
        return () => {
          document.removeEventListener("mousedown", onDocDown);
          document.removeEventListener("keydown", onKey);
          window.removeEventListener("resize", onShift);
          window.removeEventListener("scroll", onShift, true);
        };
      }, [open]);
      if (loc === null) return null;
      const fastFeature = loc.feature;
      const feature = detail?.feature ?? fastFeature;
      const archived = fastFeature.archived === true || fastFeature.status === "archived";
      const branch = Object.values(feature.components ?? {})[0]?.branch ?? "";
      const comps = Object.values(feature.components ?? {}).filter((row) => row.state !== "failed");
      // fixed 定位 + 触发按钮的视口坐标：会话头部容器会裁切 absolute 浮层
      // （overflow hidden），fixed 相对视口不受影响。
      const rect = triggerRef.current?.getBoundingClientRect();
      const popoverPos = rect === undefined ? null : { top: rect.bottom + 8, right: Math.max(12, window.innerWidth - rect.right) };
      return jsxs("div", {
        ref: rootRef,
        style: { position: "relative" },
        children: [
          jsxs("button", {
            type: "button",
            ref: triggerRef,
            title: "功能工作区",
            onClick: () => { const next = !open; setOpen(next); if (next) { loadDetail(); loadInstructions(); } },
            style: {
              // 与 shell 头部标签（标准模式/agent-preset）同款：透明二级底、
              // 22px 高、6px 圆角、12px 常规字重，无描边。
              display: "inline-flex", alignItems: "center", gap: 4,
              maxWidth: 180, height: 22, padding: "0 8px", borderRadius: 6, border: "none",
              background: open ? C.hover : C.fillSoft,
              color: archived ? C.warn : C.secondary,
              fontSize: 12, lineHeight: "22px", cursor: "pointer",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
            },
            children: [
              jsxs("svg", {
                width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4,
                style: { flexShrink: 0, opacity: 0.7 },
                "aria-hidden": "true",
                children: [
                  jsx("circle", { cx: 5, cy: 3.5, r: 1.8 }),
                  jsx("circle", { cx: 5, cy: 12.5, r: 1.8 }),
                  jsx("circle", { cx: 11, cy: 5.5, r: 1.8 }),
                  jsx("path", { d: "M5 5.3v5.4M5 5.5c0 3.2 6 2.2 6-1.2" })
                ]
              }),
              jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis" }, children: `${loc.set}/${feature.feature}` })
            ]
          }),
          open && popoverPos !== null && jsxs("div", {
            style: { position: "fixed", top: popoverPos.top, right: popoverPos.right, zIndex: 10000, width: 336, maxWidth: "calc(100vw - 24px)", maxHeight: "70vh", overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 14, background: C.bgRaised, boxShadow: "0 16px 40px rgba(0,0,0,0.4)", padding: "14px 16px" },
            children: [
              // 徽章本身已显示 set/feature，浮层不再重复标题；
              // 组件行的分支徽章也只在跑偏（branchMismatch 红）时出现——
              // 正常时分支一行说完。
              jsxs("div", {
                style: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
                children: [
                  jsx("span", { style: { fontSize: 11, letterSpacing: "0.4px", color: C.faint }, children: "分支" }),
                  jsxs("div", {
                    style: { display: "flex", alignItems: "center", gap: 8, minHeight: 28, padding: "0 10px", borderRadius: 8, background: C.fillSoft },
                    children: [
                      jsxs("svg", {
                        width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4,
                        style: { flexShrink: 0, opacity: 0.6, color: C.secondary },
                        "aria-hidden": "true",
                        children: [
                          jsx("circle", { cx: 5, cy: 3.5, r: 1.8 }),
                          jsx("circle", { cx: 5, cy: 12.5, r: 1.8 }),
                          jsx("circle", { cx: 11, cy: 5.5, r: 1.8 }),
                          jsx("path", { d: "M5 5.3v5.4M5 5.5c0 3.2 6 2.2 6-1.2" })
                        ]
                      }),
                      jsx("span", { style: { ...S.mono, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: branch !== "" ? branch : "—" }),
                      archived && jsx("span", { style: { marginLeft: "auto", display: "inline-flex" }, children: jsx(Pill, { color: C.warn, children: "已归档" }) })
                    ]
                  })
                ]
              }),
              jsxs("div", {
                style: { display: "flex", flexDirection: "column", gap: 6 },
                children: [
                  jsx("span", { style: { fontSize: 11, letterSpacing: "0.4px", color: C.faint }, children: "组件" }),
                  detail === null && comps.length === 0 && jsx("div", { style: S.faint, children: "正在读取组件…" }),
                  detail !== null && comps.length === 0 && jsx("div", { style: S.faint, children: "没有可用组件" }),
                  ...comps.map((row) => {
                    const git = row.git;
                    const tone = detail === null || git === undefined ? C.faint
                      : git.present !== true || git.branchMismatch === true ? C.error
                      : (git.changed ?? 0) > 0 || (git.unpushed ?? 0) > 0 ? C.warn
                      : C.success;
                    return jsxs("div", {
                      style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 10px", borderRadius: 10, border: `1px solid ${C.border}`, background: C.bg },
                      children: [
                        jsx("span", { style: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: tone, boxShadow: `0 0 0 3px ${C.fillSoft}` } }),
                        jsx("span", { style: { fontSize: 12.5, fontWeight: 600 }, children: row.label !== undefined && row.label !== "" && row.label !== row.name ? `${row.label}（${row.name}）` : row.name }),
                        // git 详情未到时只显示组件名（快速定位的 git 只有目录存在性，
                        // 直接走 gitBadges 会误报 detached）
                        jsxs("span", {
                          style: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
                          children: detail === null
                            ? [jsx("span", { style: S.faint, children: "…" }, "loading")]
                            : gitBadges(git).filter((badge) => badge.key !== "branch" || git?.branchMismatch === true)
                        })
                      ]
                    }, row.name);
                  })
                ]
              }),
              jsxs("div", {
                style: { display: "flex", flexDirection: "column", gap: 7, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` },
                children: [
                  jsx("span", { style: { fontSize: 11, letterSpacing: "0.4px", color: C.faint }, children: "会话说明" }),
                  instructionContext === null && instructionsError === null
                    ? jsx("div", { style: S.faint, children: "正在读取会话说明…" })
                    : null,
                  instructionsError !== null
                    ? jsx("div", { style: { color: C.error, fontSize: 11.5, whiteSpace: "pre-wrap" }, children: instructionsError })
                    : null,
                  instructionContext !== null && jsxs(React.Fragment, {
                    children: [
                      jsxs("div", {
                        style: { padding: "8px 10px", borderRadius: 9, background: C.fillSoft },
                        children: [
                          jsx("div", { style: { color: C.faint, fontSize: 10.5, marginBottom: 4 }, children: "项目说明" }),
                          instructionContext.projectInstructions !== ""
                            ? jsx("div", { style: { color: C.secondary, fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }, children: instructionContext.projectInstructions })
                            : jsx("div", { style: S.faint, children: "未配置" })
                        ]
                      }),
                      jsxs("div", {
                        style: { display: "flex", flexDirection: "column", gap: 5 },
                        children: [
                          jsx("div", { style: { color: C.faint, fontSize: 10.5 }, children: "功能区说明（可编辑）" }),
                          jsx("textarea", {
                            className: "wft-input",
                            style: { minHeight: 76, resize: "vertical", lineHeight: 1.5, fontSize: 12 },
                            value: instructions,
                            onChange: (event) => setInstructions(event.target.value),
                            placeholder: "该功能区/分支专用约定"
                          }),
                          jsxs("div", {
                            style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 },
                            children: [
                              jsx("span", { style: { ...S.faint, fontSize: 10.5 }, children: instructions === savedInstructions ? "已保存" : "有未保存修改" }),
                              jsx(Button, { small: true, disabled: instructionsBusy || instructions === savedInstructions, onClick: saveInstructions, children: instructionsBusy ? "保存中…" : "保存" })
                            ]
                          }),
                          jsx("div", { style: { ...S.faint, fontSize: 10.5 }, children: "修改后的内容从下一个新会话开始注入。" })
                        ]
                      })
                    ]
                  })
                ]
              }),
              jsxs("div", {
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` },
                children: [
                  jsx("span", { style: { ...S.faint, ...S.mono, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: feature.root, children: feature.root }),
                  jsx(Button, { small: true, onClick: () => { loadDetail(); loadInstructions(); }, children: "刷新" })
                ]
              })
            ]
          })
        ]
      });
    }

    // composer 上方按需横幅：默认不渲染；归档/目录缺失/分支跑偏才出现。
    // 用 detail 版定位（带 git 状态；晚出现一秒无妨，徽章已经即时在了）。
    function FeatureAlertDock(kit) {
      const { loc } = useFeatureLocation(kit, true);
      const alerts = featureAlerts(loc);
      if (alerts.length === 0) return null;
      const worst = alerts.some((alert) => alert.level === "error") ? C.error : C.warn;
      return jsx("div", {
        style: {
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 12px", borderRadius: 8, fontSize: 12,
          border: `1px solid ${worst}`, color: worst
        },
        children: [
          jsx("span", { children: "⚠" }),
          jsx("span", { children: alerts.map((alert) => alert.text).join("　") })
        ]
      });
    }

    /**
     * Client plugin body: mount the section into the settings shell.
     * Registration goes through ctx.slots.inject — the settings.section slot
     * is declared by the settings shell's own register(), which may commit
     * after this fiber activates.
     */
    function apply(ctx) {
      const mountResources = () => {
        const disposeStyle = installUiStyles();
        return () => {
          disposeStyle();
          locateCache.clear();
          locateInflight.clear();
          setsPromise = null;
          setsPromiseAt = 0;
        };
      };
      if (typeof ctx.effect === "function") ctx.effect(mountResources);
      else mountResources();
      const pickDirectory = () => (ctx.workspaces && typeof ctx.workspaces.pickDirectory === "function"
        ? ctx.workspaces.pickDirectory()
        : Promise.resolve(null));
      const settingsInject = () => ({ pickProjectDirectory: pickDirectory });
      const flowInject = () => ({ pick: pickDirectory });
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "worktree-flow", order: 90, label: "Worktree Flow", inject: settingsInject },
          WorktreeFlowSection,
        ),
      );
      // 「新建工作区」二选一：priority:-1 让本组件成为 directoryFlow 的胜出者
      // （single 槽取 priority 最低者），原生目录选择器被遮蔽但「普通工作区」仍经 pick 调用。
      ctx.slots.inject("sidebar.workspaces.directoryFlow", () =>
        ctx.slots.register(
          { name: "sidebar.workspaces.directoryFlow", priority: -1, inject: flowInject },
          WorktreeDirectoryFlow,
        ),
      );
      ctx.slots.inject("conversation.hero.workspace.directoryFlow", () =>
        ctx.slots.register(
          { name: "conversation.hero.workspace.directoryFlow", priority: -1, inject: flowInject },
          WorktreeDirectoryFlow,
        ),
      );
      // 会话页感知：标题旁 ⑂ 徽章（order:-20 = 静态会话上下文区）+ composer
      // 上方按需告警条。两者对非功能工作区会话都 render null。
      ctx.slots.inject("conversation.session.header.actions", () =>
        ctx.slots.register(
          { name: "conversation.session.header.actions", id: "worktree-flow-badge", order: -20 },
          FeatureBadgeAction,
        ),
      );
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          { name: "conversation.input.dock", id: "worktree-flow-alert", order: 10 },
          FeatureAlertDock,
        ),
      );
      // 注册完成即静默生效；排查时可用浏览器 devtools 的 slot 列表确认。
    }

    exports.apply = apply;
    exports.inject = ["slots", "workspaces"];
    return module.exports;
  },
});

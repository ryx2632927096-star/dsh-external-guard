/**
 * dsh-external-guard · 客户端面板
 *
 * 格式与 dsh-atlas 一致：DSH 客户端用自有加载器，不是标准 ESM。
 * 依赖面刻意收到最小 —— 只 require("react")，自己用内联样式搭，
 * 不赌宿主组件库的导出面。
 *
 * 四块：
 *   1. 侧边栏入口（sidebar.panellist）
 *   2. 主面板（main）：进程卡片列表 + 一键启停 + 日志
 */

window.__ModuleLoader__.load({
  id: "dsh-external-guard",
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")
    const h = react.createElement
    const useState = react.useState
    const useEffect = react.useEffect
    const useCallback = react.useCallback
    const useRef = react.useRef

    const API = "/dsh-external-guard"
    const PANEL_ID = "dsh-external-guard"

    /* ------------------------------------------------------------ 样式 */

    const C = {
      bg: "var(--dsh-color-bg, #fff)",
      panel: "var(--dsh-color-bg-subtle, #fafafa)",
      border: "var(--dsh-color-border, rgba(0,0,0,.10))",
      text: "var(--dsh-color-text, #1f2328)",
      sub: "var(--dsh-color-text-secondary, #6b7280)",
      ok: "#1a7f37",
      okBg: "rgba(26,127,55,.10)",
      bad: "#b42318",
      badBg: "rgba(180,35,24,.10)",
      warn: "#9a6700",
      warnBg: "rgba(154,103,0,.10)",
      accent: "#2563eb",
    }

    const S = {
      page: {
        height: "100%",
        overflowY: "auto",
        padding: "18px 22px 40px",
        background: C.bg,
        color: C.text,
        fontFamily: "inherit",
        fontSize: "13px",
        lineHeight: "1.6",
        boxSizing: "border-box",
      },
      head: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        marginBottom: "4px",
        flexWrap: "wrap",
      },
      title: { fontSize: "16px", fontWeight: 600, margin: 0 },
      meta: { color: C.sub, fontSize: "12px" },
      btn: {
        border: `1px solid ${C.border}`,
        background: C.panel,
        color: C.text,
        borderRadius: "6px",
        padding: "4px 11px",
        fontSize: "12px",
        cursor: "pointer",
        lineHeight: "20px",
      },
      btnPrimary: {
        border: `1px solid ${C.accent}`,
        background: C.accent,
        color: "#fff",
        borderRadius: "6px",
        padding: "4px 11px",
        fontSize: "12px",
        cursor: "pointer",
        lineHeight: "20px",
      },
      btnDanger: {
        border: `1px solid ${C.bad}`,
        background: "transparent",
        color: C.bad,
        borderRadius: "6px",
        padding: "4px 11px",
        fontSize: "12px",
        cursor: "pointer",
        lineHeight: "20px",
      },
      card: {
        border: `1px solid ${C.border}`,
        borderRadius: "10px",
        padding: "14px 16px",
        marginTop: "12px",
        background: C.panel,
      },
      cardHead: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        flexWrap: "wrap",
        marginBottom: "8px",
      },
      dot: {
        width: "9px",
        height: "9px",
        borderRadius: "50%",
        display: "inline-block",
        flex: "0 0 auto",
      },
      name: { fontWeight: 600, fontSize: "14px" },
      badge: {
        fontSize: "11px",
        padding: "1px 8px",
        borderRadius: "999px",
        lineHeight: "18px",
      },
      note: { color: C.sub, fontSize: "12px", margin: "2px 0 8px" },
      checks: {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
        margin: "8px 0 0",
      },
      chip: {
        fontSize: "11px",
        padding: "1px 8px",
        borderRadius: "5px",
        border: `1px solid ${C.border}`,
        fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
      },
      actions: { display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" },
      log: {
        marginTop: "10px",
        maxHeight: "220px",
        overflow: "auto",
        background: "#0d1117",
        color: "#c9d1d9",
        borderRadius: "8px",
        padding: "10px 12px",
        fontSize: "11.5px",
        lineHeight: "1.5",
        fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      },
      empty: { color: C.sub, fontSize: "12px", padding: "18px 0" },
      errBox: {
        marginTop: "10px",
        background: C.badBg,
        color: C.bad,
        border: `1px solid ${C.bad}`,
        borderRadius: "8px",
        padding: "8px 12px",
        fontSize: "12px",
      },
    }

    /* ------------------------------------------------------------ 图标 */

    function GuardIcon() {
      return h(
        "svg",
        {
          width: 16,
          height: 16,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.9,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
        [
          h("path", { key: "a", d: "M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z" }),
          h("path", { key: "b", d: "M9 12l2 2 4-4" }),
        ],
      )
    }

    /* ------------------------------------------------------------ 数据 */

    async function getJson(path, init) {
      const res = await fetch(API + path, {
        ...init,
        headers: { accept: "application/json", ...(init && init.headers) },
      })
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`)
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      return data
    }

    /* ------------------------------------------------------------ 进程卡片 */

    function StatusBadge(props) {
      const { healthy, available } = props
      if (!available) {
        return h(
          "span",
          { style: { ...S.badge, background: C.warnBg, color: C.warn } },
          "路径缺失",
        )
      }
      return h(
        "span",
        {
          style: {
            ...S.badge,
            background: healthy ? C.okBg : C.badBg,
            color: healthy ? C.ok : C.bad,
          },
        },
        healthy ? "运行中" : "未运行",
      )
    }

    function checkChip(check) {
      const color = check.ok ? C.ok : C.bad
      const bg = check.ok ? C.okBg : C.badBg
      const label =
        check.kind === "port" ? ":" + check.target : check.kind === "http" ? "HTTP" : check.target
      return h(
        "span",
        {
          key: check.kind + ":" + check.target,
          style: { ...S.chip, color, background: bg, borderColor: color },
          title: check.kind + " " + check.target + " → " + (check.ok ? "通过" : "失败"),
        },
        (check.ok ? "✓ " : "✗ ") + label,
      )
    }

    function EntryCard(props) {
      const { item, busy, onStart, onStop, onLogs, log, logsOpen, monitorOnly } = props
      const dotColor = !item.available ? C.warn : item.healthy ? C.ok : C.bad
      return h("div", { style: S.card }, [
        h("div", { key: "hd", style: S.cardHead }, [
          h("span", { key: "d", style: { ...S.dot, background: dotColor } }),
          h("span", { key: "n", style: S.name }, item.title),
          h(StatusBadge, { key: "b", healthy: item.healthy, available: item.available }),
          item.pids.length > 0
            ? h("span", { key: "p", style: S.meta }, "PID " + item.pids.join(", "))
            : null,
        ]),
        item.note ? h("div", { key: "note", style: S.note }, item.note) : null,

        item.available && item.checks.length > 0
          ? h(
              "div",
              { key: "chk", style: S.checks },
              item.checks.map(checkChip),
            )
          : null,

        !item.available && item.missing.length > 0
          ? h(
              "div",
              { key: "miss", style: S.errBox },
              "找不到这些路径：" + item.missing.join("  ·  "),
            )
          : null,

        h("div", { key: "act", style: S.actions }, [
          // 只监测模式：按钮整体不显示，只留日志入口
          monitorOnly
            ? null
            : item.canStart && !item.healthy
              ? h(
                  "button",
                  {
                    key: "start",
                    style: busy ? { ...S.btnPrimary, opacity: 0.6 } : S.btnPrimary,
                    disabled: busy,
                    onClick: function () {
                      onStart(item.id)
                    },
                  },
                  busy ? "启动中…" : "启动",
                )
              : null,
          !monitorOnly && item.healthy
            ? h(
                "button",
                {
                  key: "stop",
                  style: busy ? { ...S.btnDanger, opacity: 0.6 } : S.btnDanger,
                  disabled: busy,
                  onClick: function () {
                    onStop(item.id)
                  },
                },
                busy ? "停止中…" : "停止",
              )
            : null,
          h(
            "button",
            {
              key: "log",
              style: S.btn,
              onClick: function () {
                onLogs(item.id)
              },
            },
            logsOpen && log ? "收起日志" : "查看日志",
          ),
        ]),

        logsOpen && log
          ? h("div", { key: "logbox", style: S.log }, logText(log))
          : null,
      ])
    }

    /**
     * 拼日志面板的内容。三段按固定顺序：
     *   1. 进程自己写的日志（sources）—— 真正在增长的那份
     *   2. 本插件亲手启动时捕获的 stdout
     *   3. 同上，stderr
     * 一段都没有时给出可操作的提示，而不是空白。
     */
    function logText(log) {
      const parts = []
      const sources = Array.isArray(log.sources) ? log.sources : []
      for (const src of sources) {
        if (!src || !src.text) continue
        parts.push("=== " + (src.label || src.path) + " ===\n" + src.text)
      }
      if (log.out && log.out.text) parts.push("=== 插件启动的 stdout ===\n" + log.out.text)
      if (log.err && log.err.text) parts.push("=== 插件启动的 stderr ===\n" + log.err.text)
      if (parts.length === 0) {
        return (
          "还没有日志。\n" +
          "这个进程不是本插件启动的（由 surfcore 保活或你自己拉起），所以这里没有它的 stdout；" +
          "它的日志在清单里配置的 logSources 路径下，目前那些文件不存在或为空。"
        )
      }
      return parts.join("\n\n")
    }

    /* ------------------------------------------------------------ 主面板 */

    function GuardPanel() {
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const [busy, setBusy] = useState(null)
      const [logs, setLogs] = useState(null)
      const [logsOpen, setLogsOpen] = useState(null)
      const [action, setAction] = useState(null)
      const alive = useRef(true)

      useEffect(function () {
        alive.current = true
        return function () {
          alive.current = false
        }
      }, [])

      const refresh = useCallback(async function () {
        try {
          const data = await getJson("/status")
          if (!alive.current) return
          setState({ loading: false, data, error: null })
        } catch (err) {
          if (!alive.current) return
          setState({ loading: false, data: null, error: String(err.message || err) })
        }
      }, [])

      useEffect(
        function () {
          refresh()
          const timer = setInterval(refresh, 5000)
          return function () {
            clearInterval(timer)
          }
        },
        [refresh],
      )

      const onStart = useCallback(
        async function (id) {
          setBusy(id)
          setAction(null)
          try {
            const res = await getJson("/start", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id }),
            })
            setAction({ kind: "ok", text: id + " 已启动（PID " + (res.pid || "?") + "），正在等待端口就绪…" })
            // 给进程一点时间起监听
            await new Promise((r) => setTimeout(r, 2500))
          } catch (err) {
            setAction({ kind: "err", text: id + " 启动失败：" + String(err.message || err) })
          } finally {
            setBusy(null)
            refresh()
          }
        },
        [refresh],
      )

      const onStop = useCallback(
        async function (id) {
          setBusy(id)
          setAction(null)
          try {
            const res = await getJson("/stop", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id }),
            })
            const killed = (res.killed || []).length
            const still = (res.stillListening || []).length
            setAction({
              kind: still > 0 ? "err" : "ok",
              text:
                id + " 已停止（结束 " + killed + " 个进程）" +
                (still > 0 ? "；仍有端口在监听 PID " + res.stillListening.join(",") : ""),
            })
          } catch (err) {
            setAction({ kind: "err", text: id + " 停止失败：" + String(err.message || err) })
          } finally {
            setBusy(null)
            refresh()
          }
        },
        [refresh],
      )

      const onLogs = useCallback(async function (id) {
        if (logsOpen === id) {
          setLogsOpen(null)
          return
        }
        try {
          const data = await getJson("/logs?id=" + encodeURIComponent(id))
          setLogs(data)
          setLogsOpen(id)
        } catch (err) {
          setAction({ kind: "err", text: "读日志失败：" + String(err.message || err) })
        }
      }, [logsOpen])

      const data = state.data
      const items = data ? data.items : []
      const monitorOnly = data ? data.monitorOnly === true : false
      const downCount = items.filter((i) => i.available && !i.healthy).length

      return h("div", { style: S.page }, [
        h("div", { key: "head", style: S.head }, [
          h("h1", { key: "t", style: S.title }, "外部进程守护"),
          h(
            "span",
            { key: "m", style: S.meta },
            state.loading
              ? "读取中…"
              : data
                ? items.length + " 个受管进程 · " + downCount + " 个未运行 · " + new Date(data.at).toLocaleTimeString()
                : "未连接宿主",
          ),
          h(
            "button",
            {
              key: "r",
              style: S.btn,
              onClick: function () {
                setState({ loading: true, data: state.data, error: null })
                refresh()
              },
            },
            "刷新",
          ),
        ]),

        h(
          "div",
          { key: "hint", style: S.meta },
          monitorOnly
            ? "只监测模式：本面板只报告状态，不提供启停。" +
                "SnowLuma / Ollama 由 surfcore 插件每 2 分钟自动保活（不带窗口），" +
                "在这里加启停会和它打架——你点了停止，2 分钟内又被拉回来。"
            : "统一管理「配合别的插件使用的本机外部进程」。启动一律走隐藏窗口，不会弹控制台。停止会真正结束进程树。",
        ),

        monitorOnly
          ? h(
              "div",
              { key: "mono", style: { ...S.errBox, background: C.warnBg, color: C.warn, borderColor: C.warn } },
              "只监测模式已启用（monitorOnly=true）。如需手动启停，把 cordis.patch.yml 里的 monitorOnly 改为 false 并重启宿主。",
            )
          : null,

        data && data.configurationErrors && data.configurationErrors.length > 0
          ? h("div", { key: "config-errors", style: S.errBox },
              "进程配置无效，已停用本实例清单：" + data.configurationErrors.join("；"))
          : null,

        action
          ? h(
              "div",
              {
                key: "act",
                style:
                  action.kind === "ok"
                    ? { ...S.errBox, background: C.okBg, color: C.ok, borderColor: C.ok }
                    : S.errBox,
              },
              action.text,
            )
          : null,

        state.error
          ? h("div", { key: "err", style: S.errBox }, "宿主接口不可用：" + state.error)
          : null,

        items.length === 0 && !state.loading && !state.error
          ? h("div", { key: "empty", style: S.empty }, "没有登记任何进程。")
          : null,

        items.map(function (item) {
          return h(EntryCard, {
            key: item.id,
            item,
            busy: busy === item.id,
            onStart,
            onStop,
            onLogs,
            monitorOnly,
            logsOpen: logsOpen === item.id,
            log: logs && logs.id === item.id ? logs : null,
          })
        }),
      ])
    }

    /* ------------------------------------------------------------ 注册 */

    function apply(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
        try {
          console.error("[dsh-external-guard] ctx.slots 不可用，UI 未注册")
        } catch {
          /* ignore */
        }
        return
      }
      const disposers = []

      try {
        const d1 = slots.inject("sidebar.panellist", function () {
          return slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 55,
              label: function () {
                return "进程守护"
              },
            },
            GuardIcon,
          )
        })
        if (typeof d1 === "function") disposers.push(d1)
      } catch (e) {
        try {
          console.error("[dsh-external-guard] 侧栏入口注册失败", e)
        } catch {
          /* ignore */
        }
      }

      try {
        const d2 = slots.inject("main", function () {
          return slots.register({ name: "main", key: PANEL_ID }, GuardPanel)
        })
        if (typeof d2 === "function") disposers.push(d2)
      } catch (e) {
        try {
          console.error("[dsh-external-guard] 主面板注册失败", e)
        } catch {
          /* ignore */
        }
      }

      return function () {
        for (const d of disposers.splice(0)) {
          try {
            d()
          } catch {
            /* ignore */
          }
        }
      }
    }

    exports.apply = apply
    exports.inject = ["slots"]
    return module.exports
  },
})

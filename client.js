/**
 * 牛皮藓无限重试 — Web Client half.
 *
 * 在侧边栏「设置」里注册一页（settings.section），可以：
 *   - 临时关闭 / 重新启用无限重试；
 *   - 选择间隔方式：固定间隔 / 递增间隔 / 不间隔；
 *   - 调整基础间隔与递增上限（毫秒）；
 *   - 勾选"不应用"的供应商（活跃 + 可配置目录），或手动添加通配/自定义 id；
 *   - 开关"覆盖辅助模型调用"（标题 / 压缩 / 检索等带 purpose 的请求）。
 *
 * 配置通过预挂载的 `ctx.remote.settings` 命名空间（ns = 行 id `niupi-retry`）
 * 读写：Host 侧字段全部是 `.volatile()`，保存即时生效并持久化到 profile patch，
 * 不需要重启插件。控件为手写实现并使用主题 token，与宿主观感一致。
 */

window.__ModuleLoader__.load({
  id: '@oliver13211/dsh-plugin-niupi-retry',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const PKG_ID = '@oliver13211/dsh-plugin-niupi-retry'
    const ROW_ID = 'niupi-retry'
    const NS = 'niupi-retry'
    const MAX_DELAY_LIMIT = 3600000
    const MODES = ['fixed', 'incremental', 'none']

    const zh = {
      nav: '无限重试',
      title: '牛皮藓无限重试',
      subtitle: '模型报错后按设定间隔一直重试，直到成功或你手动停止。',
      enable: '启用无限重试',
      enableHint: '临时开关：关闭后所有失败按默认策略结束，重新打开立即生效。',
      on: '启用中',
      off: '已临时关闭',
      mode: '间隔方式',
      modeFixed: '固定间隔',
      modeIncremental: '递增间隔',
      modeNone: '不间隔',
      delayMs: '基础间隔（毫秒）',
      delayMsHint: '每次重试之间等待的时间；默认 1000 = 1 秒。',
      maxDelayMs: '递增上限（毫秒）',
      maxDelayMsHint: '递增间隔为 第 N 次重试等待 N × 基础间隔，最长不超过该上限。',
      auxiliary: '覆盖辅助模型调用',
      auxiliaryHint: '标题、压缩、检索等直接调用模型的后台请求也无限重试；只重放尚未输出任何内容的失败，避免内容重复。',
      providers: '不应用的供应商',
      providersHint: '勾选的供应商出现模型错误时按默认策略结束，不做无限重试。支持 `前缀*` 通配。',
      addPlaceholder: '供应商 id，如 deepseek-official',
      add: '添加',
      custom: '自定义',
      note: '说明：内置重试策略会先按供应商配置处理瞬态错误；耗尽后由本插件无限接管。鉴权失败、配额不足等错误也会一直重试，直到你停止。',
      error: '保存失败',
      loading: '正在读取配置…',
      missing: '设置通道不可用',
      missingHint: '当前 profile 未挂载 settings 服务。可以直接编辑 cordis.patch.yml 中 `niupi-retry` 行的 config。',
      saving: '保存中…',
      saved: '已保存',
    }
    const en = {
      nav: 'Infinite retry',
      title: 'Infinite retry',
      subtitle: 'Keeps retrying failed model requests at the configured interval until success or you stop it.',
      enable: 'Enable infinite retry',
      enableHint: 'Temporary switch: off ends failures with the default policy; turning it on applies immediately.',
      on: 'Active',
      off: 'Temporarily off',
      mode: 'Interval mode',
      modeFixed: 'Fixed',
      modeIncremental: 'Increasing',
      modeNone: 'None',
      delayMs: 'Base interval (ms)',
      delayMsHint: 'Wait between retries; default 1000 = 1 second.',
      maxDelayMs: 'Increasing cap (ms)',
      maxDelayMsHint: 'Retry N waits N × base interval, never longer than this cap.',
      auxiliary: 'Cover auxiliary model calls',
      auxiliaryHint: 'Also retries background requests (titles, compaction, search). Only failures that emitted nothing are replayed, so content never duplicates.',
      providers: 'Excluded providers',
      providersHint: 'Checked providers end failures with the default policy instead of retrying forever. `prefix*` wildcards are supported.',
      addPlaceholder: 'Provider id, e.g. deepseek-official',
      add: 'Add',
      custom: 'Custom',
      note: 'Note: built-in retry policies handle the first transient attempts; once exhausted this plugin retries forever. Auth, quota, and invalid-request failures keep retrying until you stop.',
      error: 'Save failed',
      loading: 'Loading settings…',
      missing: 'Settings channel unavailable',
      missingHint: 'The settings service is not mounted in this profile. Edit the `niupi-retry` row config in cordis.patch.yml directly.',
      saving: 'Saving…',
      saved: 'Saved',
    }

    const CSS = `
.npr-page{display:flex;flex-direction:column;gap:16px;max-width:640px;font-size:13px;color:var(--dsw-alias-label-primary);}
.npr-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;}
.npr-head{display:flex;flex-direction:column;gap:4px;}
.npr-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);}
.npr-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;}
.npr-pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);}
.npr-pill.on{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);}
.npr-pill.off{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);}
.npr-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.npr-rowlabel{display:flex;flex-direction:column;gap:2px;min-width:0;}
.npr-label{font-size:13px;color:var(--dsw-alias-label-primary);}
.npr-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;}
.npr-switch{position:relative;width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;flex:none;padding:0;}
.npr-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}
.npr-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.2);}
.npr-switch[aria-checked="true"] .npr-knob{left:18px;}
.npr-seg{display:flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;}
.npr-segbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 12px;cursor:pointer;}
.npr-segbtn + .npr-segbtn{border-left:1px solid var(--dsw-alias-border-l1);}
.npr-segbtn[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600;}
.npr-field{display:flex;flex-direction:column;gap:4px;}
.npr-input{background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12px;padding:6px 10px;width:140px;text-align:right;}
.npr-input:focus{outline:1px solid var(--dsw-alias-brand-primary);}
.npr-prov{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto;}
.npr-provrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;}
.npr-provrow:hover{background:var(--dsw-alias-interactive-bg-hover);}
.npr-check{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}
.npr-provid{font-size:12px;color:var(--dsw-alias-label-primary);}
.npr-provname{font-size:11px;color:var(--dsw-alias-label-tertiary);}
.npr-chips{display:flex;flex-wrap:wrap;gap:6px;}
.npr-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}
.npr-chipbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;padding:0;}
.npr-chipbtn:hover{color:var(--dsw-alias-state-error-primary);}
.npr-add{display:flex;gap:8px;}
.npr-addinput{flex:1;background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12px;padding:6px 10px;}
.npr-addbtn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;font-size:12px;padding:6px 12px;cursor:pointer;}
.npr-addbtn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.npr-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.6;}
.npr-err{font-size:12px;color:var(--dsw-alias-state-error-primary);}
.npr-status{font-size:11px;color:var(--dsw-alias-label-tertiary);}
`

    /** 把 Remote 包装结果（{ok,value,error}）解包成值或抛错。 */
    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return result.value
        const reason = result.error
        throw new Error(typeof reason === 'string' ? reason : reason?.message ?? 'remote call failed')
      }
      return result
    }

    function errorMessage(error) {
      if (!error) return ''
      if (typeof error === 'string') return error
      return error.message ?? String(error)
    }

    function normalizeForm(raw) {
      const value = raw && typeof raw === 'object' ? raw : {}
      return {
        enabled: value.enabled !== false,
        mode: MODES.includes(value.mode) ? value.mode : 'fixed',
        delayMs: Number.isFinite(value.delayMs) ? value.delayMs : 1000,
        maxDelayMs: Number.isFinite(value.maxDelayMs) ? value.maxDelayMs : 60000,
        auxiliary: value.auxiliary !== false,
        excludeProviders: Array.isArray(value.excludeProviders) ? value.excludeProviders.map((id) => String(id)) : [],
      }
    }

    function apply(ctx) {
      let locale = null
      let remote = null
      try { locale = ctx.get('locale') } catch {}
      try { remote = ctx.get('remote') } catch {}

      let disposed = false
      let reloadToken = 0
      let snapshot = { phase: 'loading', form: null, revision: 0, providers: [], error: null, saving: false, savedAt: 0 }
      const listeners = new Set()

      const store = {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        getSnapshot() { return snapshot },
        set(next) {
          snapshot = typeof next === 'function' ? next(snapshot) : { ...snapshot, ...next }
          for (const listener of listeners) { try { listener() } catch {} }
        },
      }

      function translate(key) {
        const dict = zh
        return dict[key] ?? key
      }

      async function loadProviders() {
        const byId = new Map()
        try {
          const active = unwrap(await remote.llm.listProviders())
          for (const provider of Array.isArray(active) ? active : []) {
            if (provider?.id) byId.set(String(provider.id), String(provider.name ?? provider.id))
          }
        } catch {}
        try {
          const dormant = unwrap(await remote.llm.listConfigurableProviders())
          for (const entry of Array.isArray(dormant) ? dormant : []) {
            if (entry?.provider) byId.set(String(entry.provider), String(entry.displayName ?? entry.provider))
          }
        } catch {}
        return [...byId.entries()].map(([id, name]) => ({ id, name: name === id ? '' : name })).sort((a, b) => a.id.localeCompare(b.id))
      }

      async function reload() {
        if (disposed || !remote) return
        const token = ++reloadToken
        try {
          const described = unwrap(await remote.settings.describe())
          if (disposed || token !== reloadToken) return
          const namespaces = Array.isArray(described?.namespaces) ? described.namespaces : []
          const mine = namespaces.find((entry) => entry?.ns === ROW_ID)
          if (!mine) {
            store.set({ phase: 'missing', form: null, revision: 0, error: null })
            return
          }
          const providers = await loadProviders()
          if (disposed || token !== reloadToken) return
          store.set({
            phase: 'ready',
            form: normalizeForm(mine.value),
            revision: Number(mine.revision) || 0,
            providers,
            error: null,
            saving: false,
          })
        } catch (error) {
          if (disposed || token !== reloadToken) return
          store.set({ phase: 'error', error: errorMessage(error) })
        }
      }

      async function save(patch) {
        if (!remote) return
        const previous = store.getSnapshot()
        const optimistic = { ...normalizeForm(previous.form), ...patch }
        store.set({ form: optimistic, saving: true, error: null })
        try {
          await unwrap(await remote.settings.update(ROW_ID, patch, previous.revision))
          await reload()
          if (!disposed) store.set({ savedAt: Date.now() })
        } catch (error) {
          if (disposed) return
          store.set({ saving: false, error: errorMessage(error) })
          reload()
        }
      }

      const offEvents = []
      if (remote) {
        try { offEvents.push(remote.$on('settings/document-updated', (ns) => { if (ns === undefined || ns === ROW_ID) reload() })) } catch {}
        try { offEvents.push(remote.$on('llm/adapters-updated', () => reload())) } catch {}
      }
      try { offEvents.push(ctx.on('connection/reset', () => reload())) } catch {}

      const stopSlot = ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: ROW_ID,
        order: 45,
        label: () => translate('nav'),
        locale: NS,
        inject: () => ({ t: translate, store, save }),
      }, SettingsPage)), 'niupi-retry: settings page')

      ctx.effect(() => locale?.register?.(NS, { zh, en }), 'niupi-retry: locale')
      reload()

      return () => {
        disposed = true
        reloadToken += 1
        for (const off of offEvents) { try { off?.() } catch {} }
        stopSlot?.()
      }
    }

    // ── 控件 ────────────────────────────────────────────────────────────────
    function Switch({ checked, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: 'npr-switch',
        onClick: () => onChange(!checked),
      }, h('span', { className: 'npr-knob' }))
    }

    function NumberField({ value, onCommit, label, hint }) {
      const [draft, setDraft] = useState(String(value))
      const focusedRef = useRef(false)
      useEffect(() => { if (!focusedRef.current) setDraft(String(value)) }, [value])
      const commit = () => {
        focusedRef.current = false
        const parsed = Math.max(0, Math.min(MAX_DELAY_LIMIT, Math.trunc(Number(draft))))
        if (!Number.isFinite(parsed) || parsed === value) { setDraft(String(value)); return }
        onCommit(parsed)
      }
      return h('div', { className: 'npr-field' },
        h('div', { className: 'npr-row' },
          h('div', { className: 'npr-rowlabel' },
            h('span', { className: 'npr-label' }, label),
            h('span', { className: 'npr-hint' }, hint),
          ),
          h('input', {
            className: 'npr-input',
            type: 'number',
            min: 0,
            max: MAX_DELAY_LIMIT,
            step: 100,
            value: draft,
            onFocus: () => { focusedRef.current = true },
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } },
          }),
        ),
      )
    }

    function SettingsPage({ t, store, save }) {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const [draftProvider, setDraftProvider] = useState('')
      const form = state.form

      const setField = useCallback((patch) => save(patch), [])
      const toggleExclude = useCallback((id) => {
        const current = normalizeForm(store.getSnapshot().form).excludeProviders
        const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
        save({ excludeProviders: next })
      }, [])
      const addExclude = useCallback(() => {
        const id = draftProvider.trim()
        if (!id) return
        const current = normalizeForm(store.getSnapshot().form).excludeProviders
        if (current.includes(id)) { setDraftProvider(''); return }
        save({ excludeProviders: [...current, id] })
        setDraftProvider('')
      }, [draftProvider])

      const excluded = useMemo(() => new Set(form?.excludeProviders ?? []), [form?.excludeProviders])
      const catalogIds = useMemo(() => new Set(state.providers.map((provider) => provider.id)), [state.providers])
      const customIds = useMemo(() => (form?.excludeProviders ?? []).filter((id) => !catalogIds.has(id)), [form?.excludeProviders, catalogIds])

      const style = h('style', { key: 'npr-css' }, CSS)

      if (state.phase === 'loading') {
        return h('div', { className: 'npr-page' }, style, h('div', { className: 'npr-status' }, t('loading')))
      }
      if (state.phase === 'missing' || state.phase === 'error' || !form) {
        return h('div', { className: 'npr-page' }, style,
          h('div', { className: 'npr-card' },
            h('div', { className: 'npr-title' }, t('title')),
            h('div', { className: 'npr-sub' }, state.phase === 'error' ? `${t('error')}: ${state.error ?? ''}` : t('missingHint')),
          ),
        )
      }

      const rows = []
      rows.push(h('div', { className: 'npr-row', key: 'enable' },
        h('div', { className: 'npr-rowlabel' },
          h('span', { className: 'npr-label' }, t('enable')),
          h('span', { className: 'npr-hint' }, t('enableHint')),
        ),
        h(Switch, {
          checked: form.enabled,
          label: t('enable'),
          onChange: (value) => setField({ enabled: value }),
        }),
      ))

      rows.push(h('div', { className: 'npr-row', key: 'mode' },
        h('div', { className: 'npr-rowlabel' }, h('span', { className: 'npr-label' }, t('mode'))),
        h('div', { className: 'npr-seg', role: 'group', 'aria-label': t('mode') },
          MODES.map((mode) => h('button', {
            key: mode,
            type: 'button',
            className: 'npr-segbtn',
            'aria-pressed': form.mode === mode ? 'true' : 'false',
            onClick: () => { if (form.mode !== mode) setField({ mode }) },
          }, t(`mode${mode[0].toUpperCase()}${mode.slice(1)}`))),
        ),
      ))

      if (form.mode !== 'none') {
        rows.push(h(NumberField, {
          key: 'delay',
          value: form.delayMs,
          label: t('delayMs'),
          hint: t('delayMsHint'),
          onCommit: (value) => setField({ delayMs: value }),
        }))
      }
      if (form.mode === 'incremental') {
        rows.push(h(NumberField, {
          key: 'maxDelay',
          value: form.maxDelayMs,
          label: t('maxDelayMs'),
          hint: t('maxDelayMsHint'),
          onCommit: (value) => setField({ maxDelayMs: value }),
        }))
      }

      rows.push(h('div', { className: 'npr-row', key: 'aux' },
        h('div', { className: 'npr-rowlabel' },
          h('span', { className: 'npr-label' }, t('auxiliary')),
          h('span', { className: 'npr-hint' }, t('auxiliaryHint')),
        ),
        h(Switch, {
          checked: form.auxiliary,
          label: t('auxiliary'),
          onChange: (value) => setField({ auxiliary: value }),
        }),
      ))

      return h('div', { className: 'npr-page' }, style,
        h('div', { className: 'npr-card' },
          h('div', { className: 'npr-head' },
            h('div', { className: 'npr-title' },
              t('title'),
              h('span', { className: `npr-pill ${form.enabled ? 'on' : 'off'}` }, form.enabled ? t('on') : t('off')),
            ),
            h('div', { className: 'npr-sub' }, t('subtitle')),
          ),
          rows,
        ),
        h('div', { className: 'npr-card' },
          h('div', { className: 'npr-rowlabel' },
            h('span', { className: 'npr-label' }, t('providers')),
            h('span', { className: 'npr-hint' }, t('providersHint')),
          ),
          h('div', { className: 'npr-prov' },
            state.providers.map((provider) => h('label', { className: 'npr-provrow', key: provider.id },
              h('input', {
                type: 'checkbox',
                className: 'npr-check',
                checked: excluded.has(provider.id),
                onChange: () => toggleExclude(provider.id),
              }),
              h('span', { className: 'npr-provid' }, provider.id),
              provider.name ? h('span', { className: 'npr-provname' }, provider.name) : null,
            )),
          ),
          customIds.length > 0 ? h('div', { className: 'npr-chips' },
            customIds.map((id) => h('span', { className: 'npr-chip', key: id },
              `${t('custom')}: ${id}`,
              h('button', {
                type: 'button',
                className: 'npr-chipbtn',
                'aria-label': `${t('providers')} ${id}`,
                onClick: () => toggleExclude(id),
              }, '×'),
            )),
          ) : null,
          h('div', { className: 'npr-add' },
            h('input', {
              className: 'npr-addinput',
              placeholder: t('addPlaceholder'),
              value: draftProvider,
              onChange: (event) => setDraftProvider(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); addExclude() } },
            }),
            h('button', { type: 'button', className: 'npr-addbtn', onClick: addExclude }, t('add')),
          ),
        ),
        h('div', { className: 'npr-note' }, t('note')),
        state.saving ? h('div', { className: 'npr-status' }, t('saving')) : null,
        state.error ? h('div', { className: 'npr-err' }, `${t('error')}: ${state.error}`) : null,
      )
    }

    return { inject: ['remote.settings', 'remote.llm', 'slots', 'locale'], apply }
  },
})

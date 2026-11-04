window.__ModuleLoader__.load({
  id: '@local/convax-note',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function Note({ node, busy, command, remove, labels }) {
      const [text, setText] = React.useState(node.data.text)
      const [failed, setFailed] = React.useState(false)
      React.useEffect(() => { setText(node.data.text) }, [node.data.text])
      return h('article', {
        style: { width: 320, padding: 12, border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
        'data-local-convax-note': node.id,
      },
      h('header', null, labels.title),
      h('textarea', { className: 'nodrag nowheel', value: text, disabled: busy, 'aria-label': labels.text,
        style: { boxSizing: 'border-box', width: '100%', minHeight: 96, marginBlock: 8, font: 'inherit', color: 'inherit', background: 'inherit' },
        onChange: event => { setText(event.target.value); setFailed(false) },
      }),
      h('div', { className: 'nodrag', style: { display: 'flex', gap: 8 } },
        h('button', { disabled: busy, onClick: async () => {
          try { setFailed(!await command({ kind: 'update-node', nodeId: node.id, dataVersion: 1, data: { text } })) }
          catch (_saveFailure) { setFailed(true) }
        } }, labels.save),
        h('button', { disabled: busy, onClick: remove }, labels.remove)),
      failed ? h('p', { role: 'status' }, labels.failed) : null)
    }
    return {
      inject: ['locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('local.convax-note', {
          en: { title: 'Note', text: 'Note text', save: 'Save', remove: 'Remove', failed: 'The note was not saved. Try again.' },
          zh: { title: '笔记', text: '笔记内容', save: '保存', remove: '移除', failed: '笔记未保存，请重试。' },
          ja: {
            "title": "メモ",
            "text": "メモの内容",
            "save": "保存",
            "remove": "削除",
            "failed": "メモを保存できませんでした。再試行してください。"
          },
          es: {
            "title": "Nota",
            "text": "Texto de la nota",
            "save": "Guardar",
            "remove": "Eliminar",
            "failed": "No se guardó la nota. Vuelve a intentarlo."
          },
          fr: {
            "title": "Note",
            "text": "Texte de la note",
            "save": "Enregistrer",
            "remove": "Supprimer",
            "failed": "La note n’a pas été enregistrée. Réessayez."
          },
          de: {
            "title": "Notiz",
            "text": "Notiztext",
            "save": "Speichern",
            "remove": "Entfernen",
            "failed": "Die Notiz wurde nicht gespeichert. Versuchen Sie es erneut."
          },
          ru: {
            "title": "Заметка",
            "text": "Текст заметки",
            "save": "Сохранить",
            "remove": "Удалить",
            "failed": "Заметка не сохранена. Повторите попытку."
          },
          pt: {
            "title": "Nota",
            "text": "Texto da nota",
            "save": "Salvar",
            "remove": "Remover",
            "failed": "A nota não foi salva. Tente novamente."
          },
        }))
        const t = ctx.locale.bind('local.convax-note')
        ctx.inject(['convaxRenderer'], scope => scope.convaxRenderer.registerNodeRenderer('local.note', {
          dataVersion: 1,
          component: props => h(Note, { ...props, labels: {
            title: t('title'), text: t('text'), save: t('save'), remove: t('remove'), failed: t('failed'),
          } }),
        }))
      },
    }
  },
})

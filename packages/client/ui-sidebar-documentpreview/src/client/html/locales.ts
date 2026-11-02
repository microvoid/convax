/** Locale-owned HTML implementation name and iframe status text. */
export const zh = {
  title: 'HTML',
  frame: 'HTML 文档预览',
  loading: '文档渲染中...',
  failed: '无法预览这份 HTML 文档',
  'interaction.enter': '进入内容交互',
  'interaction.leave': '退出内容交互',
} satisfies Record<string, string>

/** HTML renderer dictionary keys. */
export type HtmlPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'HTML',
  frame: 'HTML document preview',
  loading: 'Rendering document...',
  failed: 'This HTML document could not be previewed.',
  'interaction.enter': 'Interact with content',
  'interaction.leave': 'Stop interacting',
} satisfies Record<HtmlPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HTML preview selection and status text. */
    documentHtml: HtmlPreviewKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': 'HTML',
  'frame': 'HTMLドキュメントのプレビュー',
  'loading': 'ドキュメントをレンダリング中...',
  'failed': 'このHTMLドキュメントをプレビューできませんでした。',
  'interaction.enter': 'コンテンツを操作',
  'interaction.leave': '操作を終了',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'HTML',
  frame: 'Vista previa del documento HTML',
  loading: 'Representando documento...',
  failed: 'No se pudo obtener una vista previa de este documento HTML.',
  'interaction.enter': 'Interactuar con el contenido',
  'interaction.leave': 'Dejar de interactuar',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: 'HTML',
  frame: 'Aperçu du document HTML',
  loading: 'Rendu du document...',
  failed: "Ce document HTML n'a pas pu être prévisualisé.",
  'interaction.enter': 'Interagir avec le contenu',
  'interaction.leave': 'Arrêter les interactions',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'HTML',
  frame: 'Vorschau des HTML-Dokuments',
  loading: 'Dokument wird gerendert...',
  failed: 'Dieses HTML-Dokument konnte nicht in der Vorschau angezeigt werden.',
  'interaction.enter': 'Mit Inhalt interagieren',
  'interaction.leave': 'Interaktion beenden',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'HTML',
  frame: 'Предварительный просмотр HTML-документа',
  loading: 'Оформление документа...',
  failed: 'Этот HTML-документ не удалось просмотреть.',
  'interaction.enter': 'Взаимодействовать с содержимым',
  'interaction.leave': 'Завершить взаимодействие',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'HTML',
  frame: 'Pré-visualização do documento HTML',
  loading: 'Renderizando documento...',
  failed: 'Este documento HTML não pôde ser visualizado.',
  'interaction.enter': 'Interagir com o conteúdo',
  'interaction.leave': 'Parar de interagir',
} satisfies Record<keyof typeof en, string>

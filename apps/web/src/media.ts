/** Localized demo files are bundled from the same assets used by the READMEs. */
import projectsZh from '../../../docs/assets/convax-demos/projects-zh.mp4?url'
import projectsEn from '../../../docs/assets/convax-demos/projects-en.mp4?url'
import appsZh from '../../../docs/assets/convax-demos/apps-zh.mp4?url'
import appsEn from '../../../docs/assets/convax-demos/apps-en.mp4?url'
import projectsPosterZh from './assets/projects-zh.jpg'
import projectsPosterEn from './assets/projects-en.jpg'
import appsPosterZh from './assets/apps-zh.jpg'
import appsPosterEn from './assets/apps-en.jpg'

/** Video and poster addresses for each supported page language. */
export const media = {
  zh: {
    projects: { src: projectsZh, poster: projectsPosterZh },
    apps: { src: appsZh, poster: appsPosterZh },
  },
  en: {
    projects: { src: projectsEn, poster: projectsPosterEn },
    apps: { src: appsEn, poster: appsPosterEn },
  },
}

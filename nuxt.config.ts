// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  ssr: false,
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL ?? '/',
    head: {
      htmlAttrs: { lang: 'ru' },
      title: 'Раскраска для Procreate',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Превращает картинку в .procreate раскраску и .swatches палитру прямо в браузере' },
      ],
    },
  },
  css: ['~/assets/main.css'],
})

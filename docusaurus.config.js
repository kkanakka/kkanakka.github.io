// @ts-check
const { themes: prismThemes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Kiran's Tech Hub",
  tagline: 'Coding, Linux internals, system design, and SRE interview preparation',
  favicon: 'img/favicon.ico',

  url: 'https://kkanakka.github.io',
  baseUrl: '/',
  organizationName: 'kkanakka',
  projectName: 'kkanakka.github.io',
  trailingSlash: false,

  // A bad internal link should fail the build, not ship a dead page.
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'warn',

  i18n: { defaultLocale: 'en', locales: ['en'] },

  // 'detect' means .md files are parsed as CommonMark rather than MDX, so the
  // braces and stray '<' that survive from the original HTML stay literal
  // instead of being read as JSX. Use .mdx when a page genuinely needs React.
  markdown: {
    format: 'detect',
    hooks: { onBrokenMarkdownLinks: 'warn', onBrokenMarkdownImages: 'throw' },
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          routeBasePath: '/docs',
          editUrl: 'https://github.com/kkanakka/kkanakka.github.io/tree/main/',
          showLastUpdateTime: true,
        },
        blog: false,
        theme: { customCss: require.resolve('./src/css/custom.css') },
      }),
    ],
  ],

  themes: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      { hashed: true, indexBlog: false, docsRouteBasePath: '/docs', highlightSearchTermsOnTargetPage: true },
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/docusaurus-social-card.jpg',
      colorMode: { defaultMode: 'light', respectPrefersColorScheme: true },
      navbar: {
        title: "Kiran's Tech Hub",
        logo: { alt: '', src: 'img/logo.svg' },
        items: [
          { type: 'docSidebar', sidebarId: 'docsSidebar', position: 'left', label: 'Guides' },
          { to: '/docs/coding', label: 'Coding', position: 'left' },
          { to: '/docs/linux', label: 'Linux', position: 'left' },
          { to: '/docs/nalsd', label: 'NALSD', position: 'left' },
          { to: '/docs/sre', label: 'SRE', position: 'left' },
          { to: '/docs/ai-system-design', label: 'AI', position: 'left' },
          { href: 'https://github.com/kkanakka/kkanakka.github.io', label: 'GitHub', position: 'right' },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Foundations',
            items: [
              { label: 'Coding & Algorithms', to: '/docs/coding' },
              { label: 'Linux Internals', to: '/docs/linux' },
              { label: 'System Design Basics', to: '/docs/foundations' },
            ],
          },
          {
            title: 'System Design',
            items: [
              { label: 'Data-Intensive Systems', to: '/docs/ddia' },
              { label: 'NALSD', to: '/docs/nalsd' },
              { label: 'Hello Interview', to: '/docs/hello-interview' },
            ],
          },
          {
            title: 'Production & AI',
            items: [
              { label: 'SRE Interview Prep', to: '/docs/sre' },
              { label: 'LinkedIn Systems', to: '/docs/linkedin' },
              { label: 'AI System Design', to: '/docs/ai-system-design' },
            ],
          },
        ],
        copyright: `Kiran's Tech Hub — built for learning and interview preparation.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'python', 'sql', 'yaml', 'json', 'go', 'java', 'c'],
      },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 4 },
    }),
};

module.exports = config;

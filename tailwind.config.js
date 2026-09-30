// Tailwind JIT build config (self-hosted; no CDN). Run: npx tailwindcss -c tailwind.config.js -i tools/tailwind.src.css -o assets/css/tailwind.css --minify
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
'./server/views/**/*.ejs',
    './assets/js/**/*.js',
    './shared/**/*.js',
  ],
  safelist: [
    'w-9 h-9', 'w-10 h-10', 'w-11 h-11', 'w-12 h-12',
    'bg-secondary-container text-on-secondary-container',
    'bg-error-container/80 text-on-error-container',
    'bg-primary-container/40',
    'rounded-tr-sm', 'rounded-tl-sm',
    'bg-warning',
  ],
  theme: {
    extend: {
      colors: {
        "outline-variant": "#464555", "background": "#0b1326", "surface-container-highest": "#2d3449",
        "tertiary-container": "#bf0f3c", "on-surface": "#dae2fd", "surface-container-lowest": "#060e20",
        "primary-fixed-dim": "#c3c0ff", "inverse-primary": "#4d44e3", "on-tertiary-fixed": "#40000d",
        "primary-container": "#4f46e5", "on-tertiary-container": "#ffd0d2", "error": "#ffb4ab",
        "inverse-surface": "#dae2fd", "primary": "#c3c0ff", "on-primary-fixed-variant": "#3323cc",
        "surface-dim": "#0b1326", "on-secondary-container": "#00311f", "secondary-container": "#00a572",
        "on-surface-variant": "#c7c4d8", "secondary": "#4edea3", "outline": "#918fa1",
        "tertiary-fixed": "#ffdadb", "error-container": "#93000a", "on-secondary": "#003824",
        "primary-fixed": "#e2dfff", "on-error-container": "#ffdad6", "on-tertiary": "#67001b",
        "on-secondary-fixed-variant": "#005236", "surface-variant": "#2d3449", "inverse-on-surface": "#283044",
        "on-secondary-fixed": "#002113", "surface-bright": "#31394d", "on-background": "#dae2fd",
        "on-error": "#690005", "tertiary-fixed-dim": "#ffb2b7", "surface-container-low": "#131b2e",
        "surface": "#0b1326", "secondary-fixed": "#6ffbbe", "tertiary": "#ffb2b7",
        "on-tertiary-fixed-variant": "#92002a", "secondary-fixed-dim": "#4edea3", "on-primary-fixed": "#0f0069",
        "surface-tint": "#c3c0ff", "surface-container": "#171f33", "on-primary": "#1d00a5",
        "surface-container-high": "#222a3d", "on-primary-container": "#dad7ff"
      },
      borderRadius: { DEFAULT: "0.25rem", lg: "0.5rem", xl: "0.75rem", full: "9999px" },
      spacing: { "grid-margin":"24px","grid-gutter":"16px","xs":"4px","sm":"8px","md":"16px","lg":"24px","xl":"40px","base":"4px" },
      fontFamily: {
        "body-md":["Vazirmatn","Tahoma","Arial","sans-serif"], "body-lg":["Vazirmatn","Tahoma","Arial","sans-serif"],
        "body-sm":["Vazirmatn","Tahoma","Arial","sans-serif"], "headline-md":["Vazirmatn","Tahoma","Arial","sans-serif"],
        "headline-lg":["Vazirmatn","Tahoma","Arial","sans-serif"], "display-md":["Vazirmatn","Tahoma","Arial","sans-serif"],
        "display-lg":["Vazirmatn","Tahoma","Arial","sans-serif"], "label-md":["Vazirmatn","Tahoma","Arial","sans-serif"], "label-sm":["Vazirmatn","Tahoma","Arial","sans-serif"]
      },
      fontSize: {
        "body-md":["16px",{"lineHeight":"24px","fontWeight":"400"}],
        "body-lg":["18px",{"lineHeight":"28px","fontWeight":"400"}],
        "body-sm":["14px",{"lineHeight":"20px","fontWeight":"400"}],
        "headline-md":["20px",{"lineHeight":"28px","fontWeight":"600"}],
        "headline-lg":["28px",{"lineHeight":"36px","fontWeight":"600"}],
        "display-md":["36px",{"lineHeight":"44px","letterSpacing":"-0.02em","fontWeight":"700"}],
        "display-lg":["48px",{"lineHeight":"56px","letterSpacing":"-0.02em","fontWeight":"700"}],
        "label-md":["14px",{"lineHeight":"20px","letterSpacing":"0.05em","fontWeight":"500"}],
        "label-sm":["12px",{"lineHeight":"16px","letterSpacing":"0.05em","fontWeight":"500"}]
      }
    }
  },
  plugins: [require('@tailwindcss/forms')],
};
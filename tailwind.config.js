/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    './lib/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background:  'hsl(var(--background))',
        foreground:  'hsl(var(--foreground))',
        border:      'hsl(var(--border))',
        input:       'hsl(var(--input))',
        ring:        'hsl(var(--ring))',
        primary: {
          DEFAULT:    'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT:    'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT:    'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT:    'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT:    'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        destructive: {
          DEFAULT:    'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        popover: {
          DEFAULT:    'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        surface: {
          1: 'hsl(var(--surface-1))',
          2: 'hsl(var(--surface-2))',
          3: 'hsl(var(--surface-3))',
        },
        brand: {
          orange: '#FF6B18',
          'orange-dim': '#cc4f00',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'gradient-x':     'gradient-x 8s ease infinite',
        'beam-spin':      'beam-spin 4s linear infinite',
        'float':          'float 6s ease-in-out infinite',
        'pulse-glow':     'pulse-glow 2s ease-in-out infinite',
        'shimmer':        'shimmer 2.5s linear infinite',
        'particle-drift': 'particle-drift 20s linear infinite',
        'grid-pan':       'grid-pan 20s linear infinite',
        'fade-up':        'fade-up 0.5s ease forwards',
        'scale-in':       'scale-in 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards',
        'slide-in-right': 'slide-in-right 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards',
        'spring-in':      'spring-in 0.6s cubic-bezier(0.34,1.56,0.64,1) forwards',
      },
      keyframes: {
        'gradient-x': {
          '0%, 100%': { 'background-position': '0% 50%' },
          '50%':       { 'background-position': '100% 50%' },
        },
        'beam-spin': {
          '0%':   { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':       { transform: 'translateY(-12px)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%':       { opacity: '0.8', transform: 'scale(1.05)' },
        },
        'shimmer': {
          '0%':   { 'background-position': '-200% 0' },
          '100%': { 'background-position':  '200% 0' },
        },
        'particle-drift': {
          '0%':   { transform: 'translateY(100vh) translateX(0)' },
          '100%': { transform: 'translateY(-100px) translateX(50px)' },
        },
        'grid-pan': {
          '0%':   { transform: 'translateX(0) translateY(0)' },
          '100%': { transform: 'translateX(-60px) translateY(-60px)' },
        },
        'fade-up': {
          '0%':   { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%':   { opacity: '0', transform: 'scale(0.8)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          '0%':   { opacity: '0', transform: 'translateX(30px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'spring-in': {
          '0%':   { opacity: '0', transform: 'scale(0.6) translateY(20px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
      },
      boxShadow: {
        'glow-orange': '0 0 20px rgba(255,107,24,0.3), 0 0 60px rgba(255,107,24,0.1)',
        'glow-sm':     '0 0 10px rgba(255,107,24,0.2)',
        'glass':       '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
        'card':        '0 4px 24px rgba(0,0,0,0.3)',
        'elevated':    '0 20px 60px rgba(0,0,0,0.5)',
      },
      backgroundSize: {
        '300%': '300%',
      },
    },
  },
  plugins: [],
};

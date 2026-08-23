// Hypertrade Obsidian Dark Theme
export const colors = {
  // Base colors - Obsidian Dark
  background: {
    primary: '#0a0a0f',
    secondary: '#12121a',
    tertiary: '#1a1a24',
    card: '#16161f',
    elevated: '#1e1e2a',
    /** Shimmer placeholder bars — slightly lighter than tertiary so bones read soft, not heavy */
    skeleton: '#262636',
  },
  
  // Border colors
  border: {
    primary: '#2a2a3a',
    secondary: '#3a3a4a',
    accent: '#4a4a5a',
  },
  
  // Text colors
  text: {
    primary: '#ffffff',
    secondary: '#a0a0b0',
    tertiary: '#707080',
    muted: '#505060',
  },
  
  // Accent colors
  accent: {
    // New brand palette (teal + purple)
    gold: '#5CE1E6',
    goldLight: '#7EEEF2',
    goldDark: '#4ABFC4',
    purple: '#A855F7',
    purpleLight: '#C084FC',
    blue: '#3B82F6',
    blueLight: '#60A5FA',
  },
  
  // Status colors
  status: {
    success: '#10B981',
    successLight: '#34D399',
    successDark: '#059669',
    error: '#F43F5E',
    errorLight: '#FB7185',
    errorDark: '#E11D48',
    warning: '#FFB300',
    warningLight: '#FFCA28',
    info: '#29B6F6',
  },
  
  // Chart colors
  chart: {
    green: '#00C853',
    red: '#FF5252',
    volume: '#3B82F6',
    grid: '#2a2a3a',
    crosshair: '#505060',
  },
  
  // Glassmorphism
  glass: {
    background: 'rgba(22, 22, 31, 0.8)',
    border: 'rgba(255, 255, 255, 0.1)',
    highlight: 'rgba(255, 255, 255, 0.05)',
  },
  
  // Leverage badge colors
  leverage: {
    high: '#A855F7',     // 20x+ - Purple
    medium: '#5CE1E6',   // 10x-19x - Teal
    low: '#FACC15',      // 3x-5x - Yellow
    default: '#505060',  // 1x - Gray
  },
};

// Helper function to get leverage badge color
export const getLeverageColor = (leverage: number): string => {
  if (leverage >= 20) return colors.leverage.high;
  if (leverage >= 10) return colors.leverage.medium;
  if (leverage >= 3) return colors.leverage.low;
  return colors.leverage.default;
};

// Helper function to get price change color
export const getPriceChangeColor = (change: number | null): string => {
  if (change === null) return colors.text.tertiary;
  if (change > 0) return colors.status.success;
  if (change < 0) return colors.status.error;
  return colors.text.tertiary;
};

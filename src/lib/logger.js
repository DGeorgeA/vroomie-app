/**
 * Structured Logger for Vroomie Brain
 * Can be hooked into an external observability platform later.
 */

const IS_DEBUG = import.meta.env.DEV || true; // Set up debug flags as needed

export const Logger = {
  info: (message, context = {}) => {
    console.log(`[INFO] ${message}`, context);
  },
  
  warn: (message, context = {}) => {
    console.warn(`[WARN] ${message}`, context);
  },
  
  error: (message, error = null, context = {}) => {
    console.error(`[ERROR] ${message}`, error, context);
  },
  
  debug: (message, context = {}) => {
    if (IS_DEBUG) {
      console.debug(`[DEBUG] ${message}`, context);
    }
  }
};

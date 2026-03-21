export const LANGUAGES = [
    { code: 'en-US', name: 'English (US)', region: 'North America' },
    { code: 'en-GB', name: 'English (UK)', region: 'Europe' },
    { code: 'es-ES', name: 'Spanish', region: 'Europe/Latin America' },
    { code: 'de-DE', name: 'German', region: 'Europe' },
    { code: 'fr-FR', name: 'French', region: 'Europe' },
    { code: 'hi-IN', name: 'Hindi', region: 'Asia' },
    { code: 'ml-IN', name: 'Malayalam', region: 'India (Kerala)' },
    { code: 'ja-JP', name: 'Japanese', region: 'Asia' },
];

export const SCRIPTS = {
    'en-US': {
        anomaly: (name) => `Hello. ${name} found. Reach out to a mechanic to cross check. Thank you and drive safe.`,
        safe: () => `Hello. No Anomalies found. Drive safe.`
    },
    'en-GB': {
        anomaly: (name) => `Hello. ${name} found. Reach out to a mechanic to cross check. Thank you and drive safe.`,
        safe: () => `Hello. No Anomalies found. Drive safe.`
    },
    'es-ES': {
        anomaly: (name) => `Hola. Se ha detectado ${name}. Contacte a un mecánico para verificar. Gracias y conduzca con cuidado.`,
        safe: () => `Hola. No se detectaron anomalías. Conduzca con cuidado.`
    },
    'de-DE': {
        anomaly: (name) => `Hallo. ${name} gefunden. Bitte wenden Sie sich an einen Mechaniker. Danke und gute Fahrt.`,
        safe: () => `Hallo. Keine Anomalien gefunden. Gute Fahrt.`
    },
    'fr-FR': {
        anomaly: (name) => `Bonjour. ${name} détecté. Contactez un mécanicien pour vérification. Merci et bonne route.`,
        safe: () => `Bonjour. Aucune anomalie détectée. Bonne route.`
    },
    'hi-IN': {
        anomaly: (name) => `Namaste. ${name} mila hai. Mechanic se sampark karein. Dhanyavad aur savdhani se gaadi chalayein.`,
        safe: () => `Namaste. Koi kharabi nahi mili. Savdhani se gaadi chalayein.`
    },
    'ml-IN': {
        anomaly: (name) => `Namaskaram. ${name} attention venam. Oru mechanicine kanikkunnathu nallathaa. Sookshikka.`,
        safe: () => `Namaskaram. Engine clean aanu. Kuzhappangalonnum kandilla. Dhairyamaayi pokaam.`,
        scanning: () => `Namaskaram. Ithuvare kuzhappangal onnum illa. Parishodhana thudarukayanu. Stop cheyyan instrucion tharuka.`
    },
    'ja-JP': {
        anomaly: (name) => `Konnichiwa. ${name} ga mitsukarimashita. Mekanikku ni sodan shite kudasai. Anzen untende.`,
        safe: () => `Konnichiwa. Ijou wa arimasen. Anzen untende.`
    },
};

export function speak(text, langCode = 'en-US') {
    if (!('speechSynthesis' in window)) {
        console.warn('Text-to-speech not supported.');
        return;
    }

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = langCode;

    // Try to find a specific voice for the language
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang === langCode) || voices.find(v => v.lang.startsWith(langCode.split('-')[0]));

    if (voice) {
        utterance.voice = voice;
    }

    utterance.rate = 0.9; // Slightly slower for clarity
    utterance.pitch = 1.0;

    window.speechSynthesis.speak(utterance);
}

// Pre-load voices (chrome requires this)
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.getVoices();
}

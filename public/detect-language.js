(function () {
  const STORAGE_KEY = "preferred-language";
  const DEFAULT_LOCALE = "ko";
  const SUPPORTED_LOCALES = ["ko", "en"];

  // 저장된 언어 설정 확인
  const savedLocale = localStorage.getItem(STORAGE_KEY);

  // 이미 저장된 설정이 있으면 해당 언어로 이동
  if (savedLocale && SUPPORTED_LOCALES.includes(savedLocale)) {
    const currentPath = window.location.pathname;
    const isEnglishPath = currentPath.startsWith("/en");
    const currentLocale = isEnglishPath ? "en" : "ko";

    // 현재 페이지 언어와 저장된 언어가 다르면 리다이렉트
    if (savedLocale !== currentLocale) {
      let targetPath;
      if (savedLocale === DEFAULT_LOCALE) {
        // 한국어로 변경: /en/... -> /...
        targetPath = currentPath.replace(/^\/en/, "") || "/";
      } else {
        // 영어로 변경: /... -> /en/...
        targetPath = "/en" + (currentPath === "/" ? "" : currentPath);
      }
      window.location.replace(targetPath);
      return;
    }
    return;
  }

  // 저장된 설정이 없으면 브라우저 언어 감지
  const browserLang = navigator.language || navigator.userLanguage || "";
  const primaryLang = browserLang.split("-")[0].toLowerCase();

  // 브라우저가 영어이고 현재 한국어 페이지라면
  if (primaryLang === "en") {
    const currentPath = window.location.pathname;
    const isEnglishPath = currentPath.startsWith("/en");

    if (!isEnglishPath) {
      // 첫 방문 시 영어 사용자에게 토스트로 언어 변경 제안 (자동 리다이렉트 대신)
      // 사용자 경험을 위해 자동 리다이렉트는 하지 않고 기본 언어(한국어) 유지
      // 언어 토글로 직접 변경하도록 유도
      localStorage.setItem(STORAGE_KEY, DEFAULT_LOCALE);
    }
  } else {
    // 한국어 또는 기타 언어는 기본 언어(한국어)로 설정
    localStorage.setItem(STORAGE_KEY, DEFAULT_LOCALE);
  }
})();

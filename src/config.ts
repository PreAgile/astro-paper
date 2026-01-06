export const SITE = {
  website: "https://example.com/", // 배포 후 도메인으로 변경하세요
  author: "김면수",
  profile: "https://github.com/preAgile",
  desc: "내일을 위한 기록 — 더 나은 엔지니어링을 향해",
  title: "Forward Engineering",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true, // show back button in post detail
  editPost: {
    enabled: false, // 포스트 편집 링크 비활성화
    text: "Edit page",
    url: "https://github.com/yourname/your-repo/edit/main/",
  },
  dynamicOgImage: true,
  dir: "ltr", // "rtl" | "auto"
  lang: "ko", // 기본 언어: 한국어
  timezone: "Asia/Seoul", // 한국 시간대
} as const;

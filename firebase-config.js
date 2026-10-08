/*
 * 온라인 저장(구글 로그인) 설정
 *
 * Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)의 firebaseConfig 값을 아래 null 자리에 붙여 넣으면 켜집니다.
 * null이면 지금처럼 이 브라우저에만 저장합니다.
 * (이 값은 공개돼도 괜찮습니다. 데이터는 Firestore 보안 규칙(firestore.rules)으로 로그인한 본인만 읽고 쓸 수 있습니다.)
 */
window.FIREBASE_CONFIG = null;

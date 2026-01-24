import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [tickets, setTickets] = useState([]);
  const [title, setTitle] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("연결 중...");

  // 티켓 목록 불러오기
  const fetchTickets = async () => {
    try {
      const res = await axios.get('http://localhost:8000/api/tickets');
      setTickets(res.data);
    } catch (err) {
      console.error("데이터 로드 실패:", err);
    }
  };

  useEffect(() => {
    fetchTickets(); // 최초 실행

    // --- SSE (Server-Sent Events) 연결 설정 ---
    const eventSource = new EventSource("http://localhost:8000/stream");

    eventSource.onopen = () => {
      console.log("📡 SSE 서버에 연결되었습니다.");
      setConnectionStatus("🟢 실시간 연결됨");
    };

    // 서버에서 'ticket_updated' 이벤트를 보낼 때 실행
    eventSource.addEventListener("ticket_updated", (e) => {
      const data = JSON.parse(e.data);
      console.log("⚡ 업데이트 알림 수신:", data);
      
      // 목록 새로고침 (가장 확실한 방법)
      fetchTickets();
      
      // (선택 사항) 브라우저 알림 등을 여기서 띄울 수 있음
    });

    eventSource.onerror = (err) => {
      console.error("SSE 연결 오류:", err);
      setConnectionStatus("🔴 연결 끊김 (재시도 중...)");
      eventSource.close();
    };

    // 컴포넌트가 사라질 때 연결 종료
    return () => {
      eventSource.close();
    };
  }, []);

  const createTicket = async () => {
    if (!title) return;
    await axios.post('http://localhost:8000/api/tickets', { title });
    setTitle("");
    fetchTickets();
  };

  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "20px", fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid #eee", marginBottom: "20px", paddingBottom: "10px" }}>
        <h1 style={{ margin: 0 }}>🚀 My Jira Board</h1>
        <span style={{ fontSize: "12px", color: connectionStatus.includes("🟢") ? "green" : "red" }}>
          {connectionStatus}
        </span>
      </header>
      
      {/* 입력 폼 */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "30px" }}>
        <input 
          style={{ flex: 1, padding: "12px", fontSize: "16px", borderRadius: "4px", border: "1px solid #ccc" }}
          value={title} 
          onChange={(e) => setTitle(e.target.value)} 
          placeholder="할 일을 입력하세요 (예: 로그인 기능 개발)" 
          onKeyDown={(e) => e.key === 'Enter' && createTicket()}
        />
        <button 
          onClick={createTicket}
          style={{ padding: "10px 20px", background: "#007bff", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "16px", fontWeight: "bold" }}
        >
          만들기
        </button>
      </div>

      {/* 티켓 리스트 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
        {tickets.map((t) => (
          <div key={t.key} style={{ 
            border: "1px solid #e1e4e8", borderRadius: "6px", padding: "16px",
            backgroundColor: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            borderLeft: t.status === "In Progress" ? "5px solid #2ea44f" : "5px solid #d1d5da"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
              <span style={{ fontWeight: "bold", color: "#586069", fontSize: "14px" }}>{t.key}</span>
              <span style={{ 
                padding: "2px 10px", borderRadius: "2em", fontSize: "12px", fontWeight: "600",
                backgroundColor: t.status === "In Progress" ? "#dafbe1" : "#f6f8fa",
                color: t.status === "In Progress" ? "#1a7f37" : "#24292e"
              }}>
                {t.status}
              </span>
            </div>
            
            <h3 style={{ margin: "0 0 12px 0", fontSize: "18px", color: "#24292e" }}>{t.title}</h3>

            <div style={{ fontSize: "13px", color: "#586069", display: "flex", gap: "15px" }}>
              {/* 브랜치 정보 */}
              {t.branch_url ? (
                <a href={t.branch_url} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", textDecoration: "none", color: "#0969da" }}>
                   🌱 브랜치 연결됨 ↗
                </a>
              ) : (
                <span style={{ color: "#959da5" }}>🌱 브랜치 없음 (git checkout -b feature/{t.key}-name)</span>
              )}

              {/* PR 정보 */}
              {t.pr_url && (
                <a href={t.pr_url} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", textDecoration: "none", color: "#8250df" }}>
                   🔀 PR 바로가기 ↗
                </a>
              )}
            </div>
          </div>
        ))}

        {tickets.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px", color: "#6a737d", backgroundColor: "#f6f8fa", borderRadius: "6px" }}>
            아직 생성된 티켓이 없습니다.
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
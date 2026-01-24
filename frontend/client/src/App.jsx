import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [tickets, setTickets] = useState([]);
  const [title, setTitle] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("연결 중...");
  
  // ✨ [추가] 복사 완료 메시지 표시용 상태
  const [isCopied, setIsCopied] = useState(false);

  // 선택된 티켓 (모달용)
  const [selectedTicket, setSelectedTicket] = useState(null);

  const COLUMNS = ["To Do", "In Progress", "Done"];

  const fetchTickets = async () => {
    try {
      const res = await axios.get('http://localhost:8000/api/tickets');
      setTickets(res.data);
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    fetchTickets();
    const eventSource = new EventSource("http://localhost:8000/stream");
    
    eventSource.onopen = () => setConnectionStatus("🟢 실시간 연결됨");
    eventSource.addEventListener("ticket_updated", (e) => fetchTickets());
    eventSource.onerror = () => { eventSource.close(); };
    
    return () => eventSource.close();
  }, []);

  const createTicket = async () => {
    if (!title) return;
    await axios.post('http://localhost:8000/api/tickets', { title });
    setTitle("");
    fetchTickets();
  };

  // --- 드래그 앤 드롭 ---
  const onDragStart = (e, ticketKey) => {
    e.dataTransfer.setData("ticketKey", ticketKey);
  };
  const onDragOver = (e) => e.preventDefault();
  const onDrop = async (e, newStatus) => {
    const ticketKey = e.dataTransfer.getData("ticketKey");
    setTickets(prev => prev.map(t => t.key === ticketKey ? { ...t, status: newStatus } : t));
    try {
      await axios.put(`http://localhost:8000/api/tickets/${ticketKey}`, { status: newStatus });
    } catch (err) { fetchTickets(); }
  };

  // --- 티켓 내용/제목 저장 ---
  const saveTicket = async () => {
    if (!selectedTicket) return;
    try {
      await axios.put(`http://localhost:8000/api/tickets/${selectedTicket.key}`, {
        title: selectedTicket.title,
        content: selectedTicket.content
      });

      // alert("저장되었습니다!");  <-- ❌ 이 줄을 삭제했습니다.
      
      fetchTickets();          // 1. 목록을 새로고침해서 변경 사항 반영
      setSelectedTicket(null); // 2. 모달창을 즉시 닫음 (저장 완료 신호)
      
    } catch (err) {
      console.error("저장 실패", err);
      alert("저장 중 오류가 발생했습니다."); // ⚠️ 에러가 났을 때는 알려주는 것이 좋습니다.
    }
  };

  // 브랜치 이름 생성 및 복사
  const copyBranchCommand = () => {
    if (!selectedTicket) return;
    
    const command = `git checkout -b feature/${selectedTicket.key}`;
    
    navigator.clipboard.writeText(command).then(() => {
      // 1. 상태를 true로 변경 (문구 표시)
      setIsCopied(true);

      // 2. 1초(1000ms) 뒤에 다시 false로 변경 (문구 숨김)
      setTimeout(() => {
        setIsCopied(false);
      }, 1000);
    });
  };

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "20px", fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", justifyContent: "space-between", marginBottom: "20px" }}>
        <h1 style={{ margin: 0 }}>🚀 My Jira Board</h1>
        <span style={{ fontSize: "14px", color: connectionStatus.includes("🟢") ? "green" : "red" }}>
          {connectionStatus}
        </span>
      </header>
      
      {/* 입력창 */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "30px" }}>
        <input 
          style={{ flex: 1, padding: "10px", fontSize: "16px" }}
          value={title} 
          onChange={(e) => setTitle(e.target.value)} 
          placeholder="새로운 할 일 입력" 
          onKeyDown={(e) => e.key === 'Enter' && createTicket()}
        />
        <button onClick={createTicket} style={{ padding: "10px 20px", background: "#007bff", color: "white", border: "none", cursor: "pointer" }}>만들기</button>
      </div>

      {/* 칸반 보드 */}
      <div style={{ display: "flex", gap: "20px", height: "calc(100vh - 200px)" }}>
        {COLUMNS.map(status => (
          <div key={status} onDragOver={onDragOver} onDrop={(e) => onDrop(e, status)}
            style={{ flex: 1, background: "#f4f5f7", borderRadius: "8px", padding: "15px", display: "flex", flexDirection: "column" }}
          >
            <h3 style={{ margin: "0 0 15px 0", color: "#5e6c84", fontSize: "14px", textTransform: "uppercase" }}>
              {status} <span style={{background:"#dfe1e6", borderRadius:"10px", padding:"2px 8px", fontSize:"12px"}}>{tickets.filter(t => t.status === status).length}</span>
            </h3>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {tickets.filter(t => t.status === status).map(t => (
                <div 
                  key={t.key}
                  draggable
                  onDragStart={(e) => onDragStart(e, t.key)}
                  onClick={() => setSelectedTicket(t)}
                  style={{ 
                    background: "white", padding: "15px", borderRadius: "4px", marginBottom: "10px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)", cursor: "pointer",
                    borderLeft: t.status === "In Progress" ? "4px solid #0052cc" : t.status === "Done" ? "4px solid #00875a" : "4px solid #42526e"
                  }}
                >
                  <div style={{ fontSize: "12px", color: "#6b778c", marginBottom: "8px", display:"flex", justifyContent:"space-between" }}>
                    <strong>{t.key}</strong>
                    {t.branch_url && <span style={{color:"green", fontWeight:"bold"}}>🌱 연결됨</span>}
                  </div>
                  {/* ✨ 메인 화면 제목 강조 */}
                  <div style={{ fontSize: "16px", fontWeight: "bold", color: "#333" }}>
                    {t.title}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 모달 (상세 보기) */}
      {selectedTicket && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100%", height: "100%",
          backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000
        }} onClick={() => setSelectedTicket(null)}>
          
          <div style={{
            background: "white", width: "600px", padding: "30px", borderRadius: "8px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)", position: "relative"
          }} onClick={(e) => e.stopPropagation()}>

            {/* ✨ 제목 수정 영역 */}
            <div style={{ marginBottom: "20px", borderBottom: "1px solid #eee", paddingBottom: "10px" }}>
              <span style={{ fontSize: "14px", color: "#5e6c84", fontWeight: "bold" }}>{selectedTicket.key}</span>
              <input 
                type="text"
                value={selectedTicket.title}
                onChange={(e) => setSelectedTicket({...selectedTicket, title: e.target.value})}
                style={{ 
                  width: "100%", fontSize: "24px", fontWeight: "bold", border: "none", 
                  outline: "none", marginTop: "5px", borderBottom: "2px solid transparent"
                }}
                onFocus={(e) => e.target.style.borderBottom = "2px solid #0052cc"}
                onBlur={(e) => e.target.style.borderBottom = "2px solid transparent"}
              />
            </div>

            {/* 깃허브 연결 정보 */}
            <div style={{ background: "#f0f8ff", padding: "15px", borderRadius: "6px", marginBottom: "20px" }}>
              {selectedTicket.branch_url ? (
                <div>
                  <div style={{fontSize: "12px", color: "#5e6c84", marginBottom: "4px"}}>GitHub Branch</div>
                  <a href={selectedTicket.branch_url} target="_blank" rel="noreferrer" 
                     style={{ color: "#0052cc", fontWeight: "bold", textDecoration: "none", display: "flex", alignItems: "center", gap: "5px" }}>
                    🌱 {selectedTicket.branch_url.split('/').pop()} 바로가기 ↗
                  </a>
                </div>
              ) : (
                <div style={{ color: "#666", fontSize: "14px" }}>
                  <div style={{marginBottom: "5px"}}>⚠️ 연결된 브랜치가 없습니다.</div>
                  {/* ✨ [추가됨] 명령어 복사 버튼 UI */}
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", background: "white", padding: "8px", borderRadius: "4px", border: "1px solid #ddd" }}>
                    <code style={{ fontFamily: "monospace", color: "#d63384", flex: 1 }}>
                      git checkout -b feature/{selectedTicket.key}
                    </code>
                    
                    {/* 복사됨 문구가 버튼 옆에 나타남 */}
                    <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                      
                      {/* ✨ isCopied가 true일 때만 보이는 문구 */}
                      {isCopied && (
                        <span style={{ fontSize: "12px", color: "green", fontWeight: "bold", animation: "fadeIn 0.2s" }}>
                          ✅ Copied!
                        </span>
                      )}

                      <button 
                        onClick={copyBranchCommand}
                        style={{ 
                          fontSize: "12px", padding: "4px 8px", cursor: "pointer", 
                          background: "#eee", border: "1px solid #ccc", borderRadius: "4px" 
                        }}
                        title="명령어 복사"
                      >
                        📋 복사
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: "11px", color: "#999", marginTop: "4px" }}>
                    Tip: 위 버튼을 눌러 복사 후 터미널에 붙여넣으세요.
                  </div>
                </div>
              )}
            </div>

            {/* 내용 입력칸 */}
            <div style={{ marginBottom: "20px" }}>
              <div style={{fontSize: "12px", color: "#5e6c84", marginBottom: "5px", fontWeight: "bold"}}>Description</div>
              <textarea 
                value={selectedTicket.content || ""} 
                onChange={(e) => setSelectedTicket({...selectedTicket, content: e.target.value})}
                style={{ width: "100%", height: "150px", padding: "10px", borderRadius: "4px", border: "1px solid #dfe1e6", resize: "none", fontSize: "14px" }}
                placeholder="티켓에 대한 상세 내용을 작성하세요..."
              />
            </div>

            {/* 버튼 */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button onClick={() => setSelectedTicket(null)} 
                style={{ padding: "8px 16px", background: "none", border: "none", cursor: "pointer", color: "#42526e" }}>
                취소
              </button>
              <button onClick={saveTicket} 
                style={{ padding: "8px 16px", background: "#0052cc", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>
                저장하기
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

export default App;
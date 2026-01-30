import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  // --- State 관리 ---
  const [projects, setProjects] = useState([]); 
  const [activeProjectId, setActiveProjectId] = useState(null); 
  
  const [tickets, setTickets] = useState([]);
  const [title, setTitle] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("연결 중...");
  
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [isCopied, setIsCopied] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectCode, setNewProjectCode] = useState("");
  const [showProjectModal, setShowProjectModal] = useState(false);

  // 드래그 추적 Ref
  const draggingTicketKey = useRef(null); 
  
  // 드래그 중 서버 알림 무시용 플래그
  const isDraggingRef = useRef(false);

  // 데이터의 진실(Source of Truth)
  const ticketsRef = useRef([]); 
  const fetchTicketsRef = useRef();

  const COLUMNS = ["To Do", "In Progress", "Done"];

  // --- 초기 데이터 로드 ---
  useEffect(() => {
    fetchProjects();
    
    const eventSource = new EventSource("http://localhost:3000/stream");
    eventSource.onopen = () => setConnectionStatus("🟢 실시간 연결됨");
    
    const handleUpdate = () => {
        // 드래그 중일 땐 서버 알림 무시
        if (isDraggingRef.current) return;
        if (fetchTicketsRef.current) fetchTicketsRef.current(); 
    };

    eventSource.addEventListener("ticket_updated", handleUpdate);
    eventSource.addEventListener("Batch Updated", handleUpdate);

    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, []);

  // 프로젝트 변경 시
  useEffect(() => {
    if (activeProjectId) {
      fetchTickets(activeProjectId);
      fetchTicketsRef.current = () => fetchTickets(activeProjectId);
    } else {
      setTickets([]);
      ticketsRef.current = [];
      fetchTicketsRef.current = null;
    }
  }, [activeProjectId]);


  // --- API 통신 ---
  const fetchProjects = async () => {
    try {
      const res = await axios.get('http://localhost:3000/api/projects');
      setProjects(res.data);
      if (res.data.length > 0 && !activeProjectId) {
        setActiveProjectId(res.data[0].id);
      }
    } catch (err) { console.error(err); }
  };

  const createProject = async () => {
    if (!newProjectName || !newProjectCode) return alert("이름과 코드를 입력하세요");
    try {
      await axios.post('http://localhost:3000/api/projects', {
        name: newProjectName,
        code: newProjectCode
      });
      setShowProjectModal(false);
      setNewProjectName("");
      setNewProjectCode("");
      fetchProjects(); 
    } catch(err) { alert(err.response?.data?.error || "생성 실패"); }
  };

  const fetchTickets = async (projectId) => {
    if (!projectId) return;
    try {
      const res = await axios.get(`http://localhost:3000/api/tickets?projectId=${projectId}`);
      setTickets(res.data);
      ticketsRef.current = res.data;
    } catch (err) { console.error(err); }
  };

  const createTicket = async () => {
    if (!title || !activeProjectId) return;
    try {
      await axios.post('http://localhost:3000/api/tickets', { 
          title, 
          projectId: activeProjectId 
      });
      setTitle("");
      fetchTickets(activeProjectId);
    } catch (err) { console.error(err); }
  };

  const saveTicket = async () => {
    if (!selectedTicket) return;
    try {
      await axios.put(`http://localhost:3000/api/tickets/${selectedTicket.key}`, {
        title: selectedTicket.title,
        content: selectedTicket.content,
        status: selectedTicket.status
      });
      fetchTickets(activeProjectId);
      setSelectedTicket(null);
    } catch (err) { alert("저장 실패"); }
  };

  // ✨ [신규] 티켓 삭제 함수 추가
  const deleteTicket = async () => {
    if (!selectedTicket) return;
    if (!window.confirm("정말 이 티켓을 삭제하시겠습니까?")) return;

    try {
      await axios.delete(`http://localhost:3000/api/tickets/${selectedTicket.key}`);
      fetchTickets(activeProjectId); // 목록 갱신
      setSelectedTicket(null); // 모달 닫기
    } catch (err) {
      alert("삭제 실패");
      console.error(err);
    }
  };

  const copyBranchCommand = () => {
    if (!selectedTicket) return;
    const command = `git checkout -b feature/${selectedTicket.key}`;
    navigator.clipboard.writeText(command).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1000);
    });
  };


  // --- 🚀 드래그 앤 드롭 (수정됨: onDrop 사용) ---
  
  const onDragStart = (e, ticketKey) => {
    draggingTicketKey.current = ticketKey;
    isDraggingRef.current = true;
    e.dataTransfer.effectAllowed = "move"; // 이동 커서 설정
  };

  // 1. 카드 이동 (Swap) - 화면 갱신
  const onDragEnterCard = (e, targetKey, targetStatus) => {
    e.preventDefault();
    if (!draggingTicketKey.current || draggingTicketKey.current === targetKey) return;

    const listCopy = [...ticketsRef.current];
    const dragIndex = listCopy.findIndex(t => t.key === draggingTicketKey.current);
    const targetIndex = listCopy.findIndex(t => t.key === targetKey);

    if (dragIndex === -1 || targetIndex === -1) return;

    const draggedItem = listCopy[dragIndex];
    listCopy.splice(dragIndex, 1);
    
    // 상태 변경 및 이동
    const updatedItem = { ...draggedItem, status: targetStatus };
    listCopy.splice(targetIndex, 0, updatedItem);

    ticketsRef.current = listCopy;
    setTickets(listCopy);
  };

  // 2. 컬럼 이동 (Move) - 화면 갱신
  const onDragEnterColumn = (e, status) => {
    e.preventDefault();
    const currentKey = draggingTicketKey.current;
    if (!currentKey) return;

    const listCopy = [...ticketsRef.current];
    const dragIndex = listCopy.findIndex(t => t.key === currentKey);
    
    if (dragIndex === -1) return;

    const draggedItem = listCopy[dragIndex];
    if (draggedItem.status === status) return; // 이미 같은 상태면 무시

    listCopy.splice(dragIndex, 1);
    
    const updatedItem = { ...draggedItem, status: status };
    listCopy.push(updatedItem); 

    ticketsRef.current = listCopy;
    setTickets(listCopy);
  };

  // 3. ✨ [핵심 수정] 드롭 시 DB 저장 (onDragEnd 대신 사용)
  // 마우스 버튼을 놓는 순간 이 함수가 무조건 실행됩니다.
  const handleDrop = async (e) => {
    e.preventDefault(); // 기본 동작 방지 필수
    
    // 드래그가 끝났으므로 플래그 해제
    isDraggingRef.current = false;
    draggingTicketKey.current = null;

    // 현재 화면에 보이는 최종 상태(Ref)를 가져옴
    const finalTickets = ticketsRef.current;
    
    // 서버 전송용 데이터
    const payload = finalTickets.map((t, index) => ({
        key: t.key,
        status: t.status,
        order_index: index
    }));

    try {
        console.log("🔥 [ON DROP] 서버로 데이터 전송 시작!", payload);
        await axios.put('http://localhost:3000/api/tickets/batch', payload);
        console.log("✅ [ON DROP] 저장 성공!");
    } catch (err) {
        console.error("❌ [ON DROP] 저장 실패", err);
        fetchTickets(activeProjectId);
    }
  };
  
  // onDragEnd는 이제 보조 역할만 함 (혹시 모를 초기화)
  const onDragEnd = () => {
      isDraggingRef.current = false;
      draggingTicketKey.current = null;
  };


  // --- 렌더링 ---
  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "sans-serif", overflow: "hidden" }}>
      
      {/* 사이드바 */}
      <div style={{ width: "260px", background: "#0747A6", color: "white", padding: "20px", display:"flex", flexDirection:"column" }}>
        <h2 style={{ fontSize: "20px", marginBottom: "30px", marginTop: 0 }}>Jira Clone</h2>
        <div style={{ marginBottom: "10px", fontWeight: "bold", fontSize: "12px", color: "#B3D4FF" }}>PROJECTS</div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, flex: 1, overflowY:"auto" }}>
          {projects.map(p => (
            <li 
              key={p.id} 
              onClick={() => setActiveProjectId(p.id)}
              style={{ 
                padding: "10px", cursor: "pointer", borderRadius: "4px", marginBottom: "5px",
                background: activeProjectId === p.id ? "rgba(255,255,255,0.2)" : "transparent",
                fontWeight: activeProjectId === p.id ? "bold" : "normal",
                display: "flex", alignItems: "center", gap: "8px"
              }}
            >
              <span style={{background:"#dfe1e6", color:"#172b4d", padding:"2px 6px", borderRadius:"3px", fontSize:"11px", fontWeight:"bold", minWidth:"30px", textAlign:"center"}}>{p.code}</span>
              <span>{p.name}</span>
            </li>
          ))}
        </ul>
        <button onClick={() => setShowProjectModal(true)} style={{ padding: "12px", background: "rgba(255,255,255,0.2)", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", marginTop: "10px", fontWeight:"bold" }}>+ 새 프로젝트 만들기</button>
      </div>

      {/* 메인 보드 */}
      <div style={{ flex: 1, padding: "20px", background: "#fff", overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", justifyContent: "space-between", marginBottom: "20px", alignItems:"center" }}>
          <div>
            <h1 style={{ margin: "0 0 5px 0", fontSize: "24px" }}>
               {projects.find(p => p.id === activeProjectId)?.name || "프로젝트를 선택하세요"}
            </h1>
            <span style={{ fontSize: "14px", color: "#6b778c" }}>
               {projects.find(p => p.id === activeProjectId) ? `${projects.find(p => p.id === activeProjectId).code} 보드` : ""}
            </span>
          </div>
          <span style={{ fontSize: "14px", fontWeight: "bold", color: connectionStatus.includes("🟢") ? "green" : "red" }}>{connectionStatus}</span>
        </header>

        {activeProjectId ? (
          <>
            <div style={{ display: "flex", gap: "10px", marginBottom: "30px" }}>
                <input style={{ flex: 1, padding: "12px", fontSize: "16px", border: "1px solid #dfe1e6", borderRadius: "4px", outline:"none" }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="이 프로젝트에 할 일을 추가하고 Enter..." onKeyDown={(e) => e.key === 'Enter' && createTicket()} />
                <button onClick={createTicket} style={{ padding: "0 20px", background: "#0052cc", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>만들기</button>
            </div>

            <div style={{ display: "flex", gap: "20px", flex: 1 }}>
                {COLUMNS.map(status => {
                const columnTickets = tickets.filter(t => t.status === status);
                return (
                    <div
                        key={status}
                        // ✨ [중요] 컬럼 전체에 onDrop 이벤트 연결
                        onDragOver={(e) => e.preventDefault()} // 이게 있어야 onDrop이 작동함
                        onDragEnter={(e) => onDragEnterColumn(e, status)}
                        onDrop={handleDrop} // ✨ 여기서 저장 함수 호출
                        style={{ flex: 1, background: "#f4f5f7", borderRadius: "8px", padding: "15px", display: "flex", flexDirection: "column", minHeight: "200px" }}
                    >
                        <h3 style={{ margin: "0 0 15px 0", color: "#5e6c84", fontSize: "12px", textTransform: "uppercase", fontWeight: "bold" }}>
                            {status} <span style={{background:"#dfe1e6", borderRadius:"10px", padding:"2px 8px", fontSize:"11px", marginLeft: "5px"}}>{columnTickets.length}</span>
                        </h3>
                        
                        <div style={{ overflowY: "auto", flex: 1, display:"flex", flexDirection:"column" }}>
                            {columnTickets.map((t) => (
                            <div
                                key={t.key}
                                draggable
                                onDragStart={(e) => onDragStart(e, t.key)}
                                onDragEnter={(e) => onDragEnterCard(e, t.key, status)}
                                onDragEnd={onDragEnd} // 얘는 보조
                                onClick={() => setSelectedTicket(t)}
                                style={{
                                    background: "white", padding: "15px", borderRadius: "4px", marginBottom: "8px",
                                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)", cursor: "grab",
                                    borderLeft: t.status === "In Progress" ? "4px solid #0052cc" : t.status === "Done" ? "4px solid #00875a" : "4px solid #42526e",
                                    transition: "background 0.2s"
                                }}
                            >
                                <div style={{ fontSize: "12px", color: "#6b778c", marginBottom: "8px", display:"flex", justifyContent:"space-between" }}>
                                    <strong>{t.key}</strong>
                                    {t.branch_url && <span style={{color:"green", fontWeight:"bold"}}>🌱</span>}
                                </div>
                                <div style={{ fontSize: "15px", color: "#172b4d" }}>{t.title}</div>
                            </div>
                            ))}
                            <div style={{ flex: 1, minHeight: "50px" }}></div>
                        </div>
                    </div>
                )
                })}
            </div>
          </>
        ) : (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", color:"#6b778c" }}>
                <div style={{fontSize:"60px", marginBottom:"20px"}}>👈</div>
                <h2 style={{margin:0}}>프로젝트를 선택해주세요</h2>
            </div>
        )}
      </div>

      {/* 모달 */}
      {showProjectModal && (
        <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }} onClick={() => setShowProjectModal(false)}>
            <div style={{ background: "white", width: "400px", padding: "30px", borderRadius: "8px" }} onClick={(e) => e.stopPropagation()}>
                <h3 style={{ marginTop: 0 }}>새 프로젝트 만들기</h3>
                <input type="text" placeholder="이름" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} style={{ width: "100%", padding: "10px", marginBottom: "10px" }} />
                <input type="text" placeholder="코드 (KEY)" value={newProjectCode} onChange={(e) => setNewProjectCode(e.target.value)} style={{ width: "100%", padding: "10px", marginBottom: "20px" }} />
                <button onClick={createProject} style={{ width:"100%", padding: "10px", background: "#0052cc", color: "white", border: "none", borderRadius: "4px" }}>생성하기</button>
            </div>
        </div>
      )}

      {/* ✨ [수정] 티켓 상세 모달 */}
      {selectedTicket && (
          <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }} onClick={() => setSelectedTicket(null)}>
            <div style={{ background: "white", width: "600px", padding: "30px", borderRadius: "8px" }} onClick={(e) => e.stopPropagation()}>
                
                {/* ✨ 상단: 키값과 닫기(X) 버튼 */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"20px", borderBottom:"1px solid #eee", paddingBottom:"10px" }}>
                     <div style={{flex: 1}}>
                         <div style={{display:"flex", alignItems:"center", gap:"10px", marginBottom:"5px"}}>
                            <span style={{fontSize:"14px", fontWeight:"bold", color:"#5e6c84"}}>{selectedTicket.key}</span>
                            <span style={{fontSize:"12px", background:"#dfe1e6", padding:"2px 6px", borderRadius:"4px", color:"#172b4d"}}>{selectedTicket.status}</span>
                         </div>
                         <input type="text" value={selectedTicket.title} onChange={(e) => setSelectedTicket({...selectedTicket, title: e.target.value})} style={{ width: "100%", fontSize: "24px", fontWeight: "bold", border:"none", outline:"none" }} />
                     </div>
                     <button onClick={() => setSelectedTicket(null)} style={{ background: "transparent", border: "none", fontSize: "24px", cursor: "pointer", color: "#6b778c", lineHeight: "1" }}>×</button>
                </div>
                
                <div style={{marginBottom:"20px"}}>
                    <h4 style={{fontSize:"12px", color:"#5e6c84", margin:"0 0 5px 0", textTransform:"uppercase"}}>Description</h4>
                    <textarea value={selectedTicket.content || ""} onChange={(e) => setSelectedTicket({...selectedTicket, content: e.target.value})} style={{ width: "100%", height: "150px", padding: "10px", borderRadius:"4px", border:"1px solid #dfe1e6", resize:"none", fontFamily:"inherit" }} placeholder="내용을 입력하세요..." />
                </div>
                
                <div style={{marginBottom:"30px"}}>
                    <h4 style={{fontSize:"12px", color:"#5e6c84", margin:"0 0 5px 0", textTransform:"uppercase"}}>Branch</h4>
                    {selectedTicket.branch_url ? (
                        <a href={selectedTicket.branch_url} target="_blank" rel="noreferrer" style={{display:"flex", alignItems:"center", gap:"5px", color:"#0052cc", textDecoration:"none", fontWeight:"bold"}}>
                            🌱 브랜치 바로가기 <span style={{fontSize:"12px"}}>↗</span>
                        </a>
                    ) : (
                        <div style={{background:"#f4f5f7", padding:"10px", borderRadius:"4px", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
                            <code style={{fontFamily:"monospace", color:"#d63384"}}>git checkout -b feature/{selectedTicket.key}</code>
                            <div style={{display:"flex", alignItems:"center", gap:"5px"}}>
                                {isCopied && <span style={{fontSize:"12px", color:"green", fontWeight:"bold"}}>Copied!</span>}
                                <button onClick={copyBranchCommand} style={{background:"#ebecf0", border:"none", padding:"4px 8px", borderRadius:"3px", cursor:"pointer", fontSize:"12px", color:"#42526e"}}>복사</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* ✨ 하단 버튼 영역: 삭제 / 닫기 / 저장 */}
                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "20px", borderTop: "1px solid #eee" }}>
                    <button onClick={deleteTicket} style={{ padding: "8px 16px", background: "#ffebe6", color: "#de350b", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>🗑️ 삭제</button>
                    <div style={{display:"flex", gap:"10px"}}>
                        <button onClick={() => setSelectedTicket(null)} style={{ padding: "8px 16px", background: "none", border: "none", cursor: "pointer", color: "#42526e" }}>닫기</button>
                        <button onClick={saveTicket} style={{ padding: "8px 20px", background: "#0052cc", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>저장하기</button>
                    </div>
                </div>
            </div>
          </div>
      )}
    </div>
  );
}

export default App;
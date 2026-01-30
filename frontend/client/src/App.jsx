import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [projects, setProjects] = useState([]); 
  const [activeProjectId, setActiveProjectId] = useState(null); 
  const [tickets, setTickets] = useState([]);
  const [title, setTitle] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("연결 중...");
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectCode, setNewProjectCode] = useState("");
  const [showProjectModal, setShowProjectModal] = useState(false);

  const draggingTicketKey = useRef(null); 
  const isDraggingRef = useRef(false);
  const ticketsRef = useRef([]); 
  const fetchTicketsRef = useRef();

  const COLUMNS = ["To Do", "In Progress", "Done"];

  useEffect(() => {
    fetchProjects();
    const eventSource = new EventSource("http://localhost:3000/stream");
    eventSource.onopen = () => setConnectionStatus("🟢 실시간 연결됨");
    
    const handleUpdate = () => {
        if (isDraggingRef.current) return;
        if (fetchTicketsRef.current) fetchTicketsRef.current(); 
    };

    eventSource.addEventListener("ticket_updated", handleUpdate);
    eventSource.addEventListener("Batch Updated", handleUpdate);
    eventSource.addEventListener("project_updated", () => fetchProjects());
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, []);

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

  useEffect(() => {
    if (selectedTicket) {
      const updatedTicket = tickets.find(t => t.key === selectedTicket.key);
      if (updatedTicket && JSON.stringify(updatedTicket) !== JSON.stringify(selectedTicket)) {
        setSelectedTicket(updatedTicket);
        setIsScanning(false);
      }
    }
  }, [tickets]);

  const fetchProjects = async () => {
    try {
      const res = await axios.get('http://localhost:3000/api/projects');
      setProjects(res.data);
      if (res.data.length > 0 && !activeProjectId) setActiveProjectId(res.data[0].id);
    } catch (err) { console.error(err); }
  };

  const createProject = async () => {
    if (!newProjectName || !newProjectCode) return alert("입력 필요");
    try {
      await axios.post('http://localhost:3000/api/projects', { name: newProjectName, code: newProjectCode });
      setShowProjectModal(false);
      setNewProjectName(""); setNewProjectCode("");
    } catch(err) { alert("생성 실패"); }
  };

  const fetchTickets = async (projectId) => {
    if (!projectId) return;
    try {
      const res = await axios.get(`http://localhost:3000/api/tickets?projectId=${projectId}`);
      setTickets(res.data);
      ticketsRef.current = res.data;
      const params = new URLSearchParams(window.location.search);
      const ticketKeyFromUrl = params.get("ticket");
      if (ticketKeyFromUrl) {
        const targetTicket = res.data.find(t => t.key === ticketKeyFromUrl);
        if (targetTicket) setSelectedTicket(targetTicket);
      }
    } catch (err) { console.error(err); }
  };

  const createTicket = async () => {
    if (!title || !activeProjectId) return;
    try {
      await axios.post('http://localhost:3000/api/tickets', { title, projectId: activeProjectId });
      setTitle("");
      fetchTickets(activeProjectId);
    } catch (err) { console.error(err); }
  };

  const saveTicket = async () => {
    if (!selectedTicket) return;
    try {
      await axios.put(`http://localhost:3000/api/tickets/${selectedTicket.key}`, {
        title: selectedTicket.title, content: selectedTicket.content, status: selectedTicket.status
      });
      fetchTickets(activeProjectId);
      handleCloseModal();
    } catch (err) { alert("저장 실패"); }
  };

  const deleteTicket = async () => {
    if (!selectedTicket || !window.confirm("삭제하시겠습니까?")) return;
    try {
      await axios.delete(`http://localhost:3000/api/tickets/${selectedTicket.key}`);
      fetchTickets(activeProjectId); 
      handleCloseModal();
    } catch (err) { alert("삭제 실패"); }
  };

  const scanTicket = async () => {
    if (!selectedTicket) return;
    setIsScanning(true);
    try { await axios.post(`http://localhost:3000/api/tickets/${selectedTicket.key}/scan`); } 
    catch (err) { alert("요청 실패"); setIsScanning(false); }
  };

  const copyBranchCommand = () => {
    if (!selectedTicket) return;
    const command = `git checkout -b feature/${selectedTicket.key}`;
    navigator.clipboard.writeText(command).then(() => {
      setIsCopied(true); setTimeout(() => setIsCopied(false), 1000);
    });
  };

  const handleOpenModal = (ticket) => {
      setSelectedTicket(ticket);
      const newUrl = `${window.location.pathname}?ticket=${ticket.key}`;
      window.history.pushState({ path: newUrl }, '', newUrl);
  };

  const handleCloseModal = () => {
      setSelectedTicket(null);
      const newUrl = window.location.pathname;
      window.history.pushState({ path: newUrl }, '', newUrl);
  };

  // 드래그 관련 핸들러들
  const onDragStart = (e, ticketKey) => {
    draggingTicketKey.current = ticketKey;
    isDraggingRef.current = true;
    e.dataTransfer.effectAllowed = "move"; 
  };
  const onDragEnterCard = (e, targetKey, targetStatus) => {
    e.preventDefault();
    if (!draggingTicketKey.current || draggingTicketKey.current === targetKey) return;
    const listCopy = [...ticketsRef.current];
    const dragIndex = listCopy.findIndex(t => t.key === draggingTicketKey.current);
    const targetIndex = listCopy.findIndex(t => t.key === targetKey);
    if (dragIndex === -1 || targetIndex === -1) return;
    const draggedItem = listCopy[dragIndex];
    listCopy.splice(dragIndex, 1);
    const updatedItem = { ...draggedItem, status: targetStatus };
    listCopy.splice(targetIndex, 0, updatedItem);
    ticketsRef.current = listCopy;
    setTickets(listCopy);
  };
  const onDragEnterColumn = (e, status) => {
    e.preventDefault();
    const currentKey = draggingTicketKey.current;
    if (!currentKey) return;
    const listCopy = [...ticketsRef.current];
    const dragIndex = listCopy.findIndex(t => t.key === currentKey);
    if (dragIndex === -1) return;
    const draggedItem = listCopy[dragIndex];
    if (draggedItem.status === status) return;
    listCopy.splice(dragIndex, 1);
    const updatedItem = { ...draggedItem, status: status };
    listCopy.push(updatedItem); 
    ticketsRef.current = listCopy;
    setTickets(listCopy);
  };
  const handleDrop = async (e) => {
    e.preventDefault(); 
    isDraggingRef.current = false;
    draggingTicketKey.current = null;
    const payload = ticketsRef.current.map((t, index) => ({ key: t.key, status: t.status, order_index: index }));
    try { await axios.put('http://localhost:3000/api/tickets/batch', payload); } catch (err) { fetchTickets(activeProjectId); }
  };
  const onDragEnd = () => { isDraggingRef.current = false; draggingTicketKey.current = null; };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "sans-serif", overflow: "hidden" }}>
      
      {/* 사이드바 */}
      <div style={{ width: "260px", background: "#0747A6", color: "white", padding: "20px", display:"flex", flexDirection:"column" }}>
        <h2 style={{ fontSize: "20px", marginBottom: "30px", marginTop: 0 }}>Jira Clone</h2>
        <div style={{ marginBottom: "10px", fontWeight: "bold", fontSize: "12px", color: "#B3D4FF" }}>PROJECTS</div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, flex: 1, overflowY:"auto" }}>
          {projects.map(p => (
            <li key={p.id} onClick={() => setActiveProjectId(p.id)} style={{ padding: "10px", cursor: "pointer", borderRadius: "4px", marginBottom: "5px", background: activeProjectId === p.id ? "rgba(255,255,255,0.2)" : "transparent", fontWeight: activeProjectId === p.id ? "bold" : "normal", display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{background:"#dfe1e6", color:"#172b4d", padding:"2px 6px", borderRadius:"3px", fontSize:"11px", fontWeight:"bold", minWidth:"30px", textAlign:"center"}}>{p.code}</span>
              <span>{p.name}</span>
            </li>
          ))}
        </ul>
        <button onClick={() => setShowProjectModal(true)} style={{ padding: "12px", background: "rgba(255,255,255,0.2)", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", marginTop: "10px", fontWeight:"bold" }}>+ 새 프로젝트</button>
      </div>

      {/* 메인 보드 */}
      <div style={{ flex: 1, padding: "20px", background: "#fff", overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", justifyContent: "space-between", marginBottom: "20px", alignItems:"center" }}>
          <div>
            <h1 style={{ margin: "0 0 5px 0", fontSize: "24px" }}>{projects.find(p => p.id === activeProjectId)?.name || "프로젝트 선택"}</h1>
            <span style={{ fontSize: "14px", color: "#6b778c" }}>{projects.find(p => p.id === activeProjectId) ? `${projects.find(p => p.id === activeProjectId).code} 보드` : ""}</span>
          </div>
          <span style={{ fontSize: "14px", fontWeight: "bold", color: connectionStatus.includes("🟢") ? "green" : "red" }}>{connectionStatus}</span>
        </header>

        {activeProjectId ? (
          <>
            <div style={{ display: "flex", gap: "10px", marginBottom: "30px" }}>
                <input style={{ flex: 1, padding: "12px", fontSize: "16px", border: "1px solid #dfe1e6", borderRadius: "4px", outline:"none" }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="할 일 추가..." onKeyDown={(e) => e.key === 'Enter' && createTicket()} />
                <button onClick={createTicket} style={{ padding: "0 20px", background: "#0052cc", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>만들기</button>
            </div>
            <div style={{ display: "flex", gap: "20px", flex: 1 }}>
                {COLUMNS.map(status => {
                const columnTickets = tickets.filter(t => t.status === status);
                return (
                    <div key={status} onDragOver={(e) => e.preventDefault()} onDragEnter={(e) => onDragEnterColumn(e, status)} onDrop={handleDrop} style={{ flex: 1, background: "#f4f5f7", borderRadius: "8px", padding: "15px", display: "flex", flexDirection: "column", minHeight: "200px" }}>
                        <h3 style={{ margin: "0 0 15px 0", color: "#5e6c84", fontSize: "12px", textTransform: "uppercase", fontWeight: "bold" }}>{status} <span style={{background:"#dfe1e6", borderRadius:"10px", padding:"2px 8px", fontSize:"11px", marginLeft: "5px"}}>{columnTickets.length}</span></h3>
                        <div style={{ overflowY: "auto", flex: 1, display:"flex", flexDirection:"column" }}>
                            {columnTickets.map((t) => (
                            <div key={t.key} draggable onDragStart={(e) => onDragStart(e, t.key)} onDragEnter={(e) => onDragEnterCard(e, t.key, status)} onDragEnd={onDragEnd} onClick={() => handleOpenModal(t)} style={{ background: "white", padding: "15px", borderRadius: "4px", marginBottom: "8px", boxShadow: "0 1px 2px rgba(0,0,0,0.1)", cursor: "grab", borderLeft: t.status === "In Progress" ? "4px solid #0052cc" : t.status === "Done" ? "4px solid #00875a" : "4px solid #42526e", transition: "background 0.2s" }}>
                                <div style={{ fontSize: "12px", color: "#6b778c", marginBottom: "8px", display:"flex", justifyContent:"space-between" }}>
                                    <strong>{t.key}</strong>
                                    {/* ✨ 브랜치나 PR이 하나라도 있으면 아이콘 표시 */}
                                    {(t.branches?.length > 0 || t.pull_requests?.length > 0) && <span style={{color:"green", fontWeight:"bold"}}>🌱</span>}
                                </div>
                                <div style={{ fontSize: "15px", color: "#172b4d" }}>{t.title}</div>
                            </div>
                            ))}
                            <div style={{ flex: 1, minHeight: "50px" }}></div>
                        </div>
                    </div>
                )})}
            </div>
          </>
        ) : (<div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", color:"#6b778c" }}><div style={{fontSize:"60px", marginBottom:"20px"}}>👈</div><h2 style={{margin:0}}>프로젝트를 선택해주세요</h2></div>)}
      </div>

      {showProjectModal && (
        <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }} onClick={() => setShowProjectModal(false)}>
            <div style={{ background: "white", width: "400px", padding: "30px", borderRadius: "8px" }} onClick={(e) => e.stopPropagation()}>
                <h3 style={{ marginTop: 0 }}>새 프로젝트</h3>
                <input type="text" placeholder="이름" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} style={{ width: "100%", padding: "10px", marginBottom: "10px" }} />
                <input type="text" placeholder="코드 (KEY)" value={newProjectCode} onChange={(e) => setNewProjectCode(e.target.value)} style={{ width: "100%", padding: "10px", marginBottom: "20px" }} />
                <button onClick={createProject} style={{ width:"100%", padding: "10px", background: "#0052cc", color: "white", border: "none", borderRadius: "4px" }}>생성</button>
            </div>
        </div>
      )}

      {selectedTicket && (
          <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }} onClick={handleCloseModal}>
            <div style={{ background: "white", width: "700px", padding: "30px", borderRadius: "8px", display: "flex", flexDirection: "column", gap: "20px" }} onClick={(e) => e.stopPropagation()}>
                
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", borderBottom:"1px solid #ebecf0", paddingBottom:"15px" }}>
                     <div style={{flex: 1}}>
                         <div style={{display:"flex", alignItems:"center", gap:"10px", marginBottom:"8px"}}>
                            <a href={`#${selectedTicket.key}`} style={{fontSize:"14px", fontWeight:"bold", color:"#5e6c84", textDecoration:"none"}}>{selectedTicket.key}</a>
                            <span style={{fontSize:"12px", background:"#dfe1e6", padding:"2px 8px", borderRadius:"3px", color:"#172b4d", fontWeight:"bold", textTransform:"uppercase"}}>{selectedTicket.status}</span>
                            <button onClick={scanTicket} disabled={isScanning} style={{border:"none", background:"transparent", cursor: isScanning ? "wait" : "pointer", fontSize:"16px", marginLeft:"5px", opacity: isScanning ? 0.5 : 1}}>{isScanning ? "⏳" : "🔄"}</button>
                         </div>
                         <input type="text" value={selectedTicket.title} onChange={(e) => setSelectedTicket({...selectedTicket, title: e.target.value})} style={{ width: "100%", fontSize: "22px", fontWeight: "600", color:"#172b4d", border:"none", outline:"none", padding:"0" }} />
                     </div>
                     <button onClick={handleCloseModal} style={{ background: "transparent", border: "none", fontSize: "24px", cursor: "pointer", color: "#6b778c", padding:"0 10px" }}>×</button>
                </div>
                
                <div style={{display: "flex", gap: "30px"}}>
                    <div style={{flex: 2}}>
                        <h4 style={{fontSize:"12px", color:"#5e6c84", margin:"0 0 8px 0", fontWeight:"bold"}}>Description</h4>
                        <textarea value={selectedTicket.content || ""} onChange={(e) => setSelectedTicket({...selectedTicket, content: e.target.value})} style={{ width: "100%", height: "300px", padding: "12px", borderRadius:"4px", border:"1px solid #dfe1e6", resize:"none", fontFamily:"inherit", fontSize:"14px", lineHeight:"1.5", color:"#172b4d", boxSizing:"border-box" }} placeholder="Add a description..." />
                    </div>

                    <div style={{flex: 1, borderLeft:"1px solid #ebecf0", paddingLeft:"20px"}}>
                        <h4 style={{fontSize:"12px", color:"#5e6c84", margin:"0 0 15px 0", fontWeight:"bold", textTransform:"uppercase"}}>Development</h4>
                        
                        {/* ✨ [수정] Branches 목록 렌더링 */}
                        <div style={{marginBottom: "20px"}}>
                            <div style={{fontSize:"13px", fontWeight:"600", color:"#172b4d", marginBottom:"8px"}}>Branches</div>
                            {selectedTicket.branches && selectedTicket.branches.length > 0 ? (
                                <div style={{display:"flex", flexDirection:"column", gap:"5px"}}>
                                    {selectedTicket.branches.map((b, idx) => (
                                        <a key={idx} href={b.url} target="_blank" rel="noreferrer" style={{display:"flex", alignItems:"center", gap:"6px", color:"#0052cc", textDecoration:"none", fontSize:"13px"}}>
                                            <span style={{fontSize:"16px"}}>🌱</span> {b.name} <span style={{fontSize:"10px", color:"#6b778c"}}>↗</span>
                                        </a>
                                    ))}
                                </div>
                            ) : (
                                <div style={{background:"#f4f5f7", padding:"10px", borderRadius:"4px"}}>
                                    <div style={{fontSize:"11px", color:"#6b778c", marginBottom:"5px"}}>Create branch:</div>
                                    <div style={{display:"flex", alignItems:"center", gap:"5px"}}>
                                        <code style={{fontFamily:"monospace", fontSize:"11px", color:"#d63384", flex:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>feature/{selectedTicket.key}</code>
                                        <button onClick={copyBranchCommand} style={{border:"1px solid #dfe1e6", background:"white", borderRadius:"3px", cursor:"pointer", padding:"2px 6px", fontSize:"10px"}}>{isCopied ? "✅" : "Copy"}</button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ✨ [수정] PR 목록 렌더링 */}
                        <div>
                            <div style={{fontSize:"13px", fontWeight:"600", color:"#172b4d", marginBottom:"8px"}}>Pull requests</div>
                            {selectedTicket.pull_requests && selectedTicket.pull_requests.length > 0 ? (
                                <div style={{display:"flex", flexDirection:"column", gap:"5px"}}>
                                    {selectedTicket.pull_requests.map((pr, idx) => (
                                        <a key={idx} href={pr.url} target="_blank" rel="noreferrer" style={{display:"flex", alignItems:"center", gap:"6px", color: pr.is_merged ? "#6f42c1" : "#0052cc", textDecoration:"none", fontSize:"13px"}}>
                                            <span style={{fontSize:"16px"}}>{pr.is_merged ? "🟣" : "🔀"}</span> 
                                            <span style={{textDecoration: pr.is_merged ? "line-through" : "none", color: pr.is_merged ? "#6b778c" : "inherit"}}>{pr.title}</span>
                                            <span style={{fontSize:"10px", color:"#6b778c"}}>↗</span>
                                        </a>
                                    ))}
                                </div>
                            ) : (
                                <div style={{fontSize:"12px", color:"#6b778c", fontStyle:"italic"}}>No pull requests</div>
                            )}
                        </div>
                    </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "15px", borderTop: "1px solid #ebecf0" }}>
                    <button onClick={deleteTicket} style={{ padding: "8px 12px", background: "transparent", color: "#de350b", border: "none", borderRadius: "3px", cursor: "pointer", fontWeight: "bold", fontSize:"14px" }}>Delete</button>
                    <div style={{display:"flex", gap:"10px"}}>
                        <button onClick={handleCloseModal} style={{ padding: "8px 16px", background: "none", border: "none", cursor: "pointer", color: "#42526e", fontSize:"14px", fontWeight:"600" }}>Cancel</button>
                        <button onClick={saveTicket} style={{ padding: "8px 20px", background: "#0052cc", color: "white", border: "none", borderRadius: "3px", cursor: "pointer", fontWeight: "bold", fontSize:"14px" }}>Save</button>
                    </div>
                </div>
            </div>
          </div>
      )}
    </div>
  );
}

export default App;
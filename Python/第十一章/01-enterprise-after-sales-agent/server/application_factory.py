"""生产和隔离测试共用的依赖组合入口。"""

from types import SimpleNamespace
from .config import Config
from .repositories import MaterialRepository, CaseRepository
from .trace import Traces
from .memory_service import Memories
from .materials_service import Materials
from .agent_service import ConsultationAgent
from .workflow import RefundWorkflow
from .investigation_service import Investigator
from .case_service import CaseService
from .app_service import ApplicationService


def create_application(db, mcp, knowledge, config=None, model_factory=None, http=None):
    config = config or Config()
    material_repository, case_repository = MaterialRepository(db), CaseRepository(db)
    trace, memory = Traces(db), Memories(db)
    materials = Materials(db, config, http)
    agent = ConsultationAgent(db, mcp, knowledge, memory, trace, material_repository, case_repository, config, model_factory)
    workflow = RefundWorkflow(db, mcp, trace)
    investigator = Investigator(trace, knowledge, config, (lambda: model_factory(None)) if model_factory else None)
    cases = CaseService(db, mcp, knowledge, workflow, trace, investigator, material_repository, case_repository)
    app = ApplicationService(db, memory, materials, agent, cases, knowledge, material_repository, config)
    return SimpleNamespace(app=app, agent=agent, workflow=workflow, materials=materials, memory=memory, trace=trace, cases=cases, investigator=investigator)

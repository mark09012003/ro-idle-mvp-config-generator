import {attackSkills, builderCatalog, equipmentCatalog, previewCharacter, scenarioCatalog, simulate, targets} from "./engine.js?v=20261127-9";

self.onmessage = ({data: {id, action, snapshot, options}}) => {
  try {
    const result = {
      targets: () => targets,
      builder: () => builderCatalog(),
      skills: () => attackSkills(snapshot),
      scenario: () => scenarioCatalog(snapshot),
      equipment: () => equipmentCatalog(snapshot),
      character: () => previewCharacter(snapshot, options.scenario, options.mode, options.monsterId),
      simulate: () => simulate(snapshot, options),
    }[action]();
    self.postMessage({id, result});
  } catch (error) {
    self.postMessage({id, error: error.message});
  }
};

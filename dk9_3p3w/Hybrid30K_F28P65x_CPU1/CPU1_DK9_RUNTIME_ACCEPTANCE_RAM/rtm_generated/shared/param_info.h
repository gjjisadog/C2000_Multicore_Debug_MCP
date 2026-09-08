#ifndef RTM_PARAM_INFO_H_
#define RTM_PARAM_INFO_H_

#include <stdint.h>

#define RTM_PARAM_SCHEMA_VERSION     5U
#define RTM_PARAM_GENERATOR_VERSION  12U
#define RTM_PARAM_INPUT_CRC32        0x46B74295UL
#define RTM_PARAM_FUNCTIONAL_CRC32   0xF9DCDE5DUL
#define RTM_PARAM_MODEL_ID           0x7D30U
#define RTM_PARAM_COUNT              236U

typedef struct
{
    uint16_t uiSchemaVersion;
    uint16_t uiGeneratorVersion;
    uint16_t uiModelId;
    uint16_t uiParamCount;
    uint32_t ulInputCrc32;
    uint32_t ulFunctionalCrc32;
} RTM_PARAM_INFO_TYPE;

extern const RTM_PARAM_INFO_TYPE g_stRtmParamInfo;

#endif
